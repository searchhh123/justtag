import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import sharp from "sharp";
import { z } from "zod";
import { config } from "./config.js";
import { bestImageUrl, type FullPost } from "./x/client.js";

/**
 * "No image? No name? No ticker? Fine."
 * Looks at every picture in the post (a clip gives its cover frame), keeps the strongest one, crops it square
 * around the action, names the coin and writes the ticker.
 */

const anthropic = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic() : null;

const imagesDir = path.join(config.dataDir, "images");
fs.mkdirSync(imagesDir, { recursive: true });

export type Pick = {
  name: string;
  ticker: string;
  description: string;
  imageBuffer: Buffer | null; // 512x512 PNG
  scores: number[]; // one per candidate image, 0-10
  chosen: number; // index into candidates, -1 if none
  safe: boolean;
  reason?: string;
};

const PickSchema = z.object({
  scores: z.array(z.number()).describe("one 0-10 score per image, in order: how strong it is as a coin image"),
  best_index: z.number().describe("index of the strongest image, or -1 if there are no images"),
  name: z.string().describe("coin name, 2-4 words, max 32 characters, catchy, taken from the post's moment"),
  ticker: z.string().describe("ticker, 3-8 uppercase letters or digits, no $"),
  description: z.string().describe("one short sentence describing the moment, max 140 characters"),
  safe: z.boolean().describe("false if the post is hateful, sexual content involving minors, targeted harassment of a private person, or a scam"),
});

const SYSTEM = `You turn viral X posts into memecoins for JustTag, a launchpad on Robinhood Chain.
Given a post's text and its images, you:
1. Score each image 0-10 as a coin image: a clear subject, readable at small sizes, captures the funny or viral moment. Screenshots of text score low.
2. Pick the strongest one.
3. Name the coin after the moment (2-4 words, max 32 chars). Prefer the concrete funny noun or action ("Jet Ski Dog", "Cat Jumps on Him").
4. Write a ticker: 3-8 uppercase letters/digits, memorable, derived from the name (JETDOG, CATCAR).
5. Flag unsafe posts. Ordinary news, memes, games, sports and celebrities are safe.
Never use real brand trademarks as the whole ticker when a descriptive one works.`;

export async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length < 20_000_000 ? buf : null;
  } catch {
    return null;
  }
}

/** Square crop that follows the most "interesting" region (sharp's attention strategy: skin, saturation, edges). */
export async function cropCoinImage(input: Buffer): Promise<Buffer> {
  return sharp(input, { failOn: "none" })
    .rotate()
    .resize(512, 512, { fit: "cover", position: sharp.strategy.attention })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function sanitizeTicker(t: string) {
  return t.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10) || "TAG";
}
function sanitizeName(n: string) {
  return n.replace(/[\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 32) || "Tagged Post";
}

/** Fallback when no AI key is configured: first image, name from the first words, ticker from the initials. */
function heuristicPick(post: FullPost): { name: string; ticker: string; description: string } {
  const words = post.tweet.text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/@\w+/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 3);
  const name = sanitizeName(words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ") || post.author.name);
  const ticker = sanitizeTicker(words.join("").slice(0, 8) || post.author.username.slice(0, 6));
  return { name, ticker, description: post.tweet.text.slice(0, 140) };
}

export async function pickCoin(post: FullPost, override?: { name?: string; ticker?: string; image?: Buffer | null }): Promise<Pick> {
  const urls = post.media.map(bestImageUrl).filter((u): u is string => !!u).slice(0, 4);
  const raw = (await Promise.all(urls.map(fetchImage))).filter((b): b is Buffer => !!b);
  // normalise for the model: JPEG, max 1024px
  const candidates = await Promise.all(
    raw.map((b) => sharp(b, { failOn: "none" }).rotate().resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()),
  );

  let name: string, ticker: string, description: string;
  let scores: number[] = candidates.map(() => 5);
  let chosen = candidates.length ? 0 : -1;
  let safe = true;
  let reason: string | undefined;

  if (anthropic) {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    candidates.forEach((buf, i) => {
      content.push({ type: "text", text: `Image ${i}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } });
    });
    content.push({
      type: "text",
      text: `Post by @${post.author.username} (${post.author.name}):\n"""${post.tweet.text}"""\n\nThere ${candidates.length === 1 ? "is 1 image" : `are ${candidates.length} images`}. Return the scores, best image, name, ticker, description and safety flag.`,
    });
    const res = await anthropic.beta.messages.parse({
      model: config.anthropicModel,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort: config.anthropicEffort, format: betaZodOutputFormat(PickSchema) },
      messages: [{ role: "user", content }],
    });
    if (res.stop_reason === "refusal") {
      safe = false;
      reason = "declined";
      ({ name, ticker, description } = heuristicPick(post));
    } else if (res.parsed_output) {
      const o = res.parsed_output;
      name = o.name;
      ticker = o.ticker;
      description = o.description;
      safe = o.safe;
      if (o.scores.length === candidates.length) scores = o.scores.map((s) => Math.round(s * 10) / 10);
      if (candidates.length) chosen = o.best_index >= 0 && o.best_index < candidates.length ? o.best_index : scores.indexOf(Math.max(...scores));
    } else {
      ({ name, ticker, description } = heuristicPick(post));
    }
  } else {
    ({ name, ticker, description } = heuristicPick(post));
  }

  if (override?.name) name = override.name;
  if (override?.ticker) ticker = override.ticker;

  let imageBuffer: Buffer | null = null;
  if (override?.image) imageBuffer = await cropCoinImage(override.image);
  else if (chosen >= 0) imageBuffer = await cropCoinImage(raw[chosen]);

  return { name: sanitizeName(name), ticker: sanitizeTicker(ticker), description, imageBuffer, scores, chosen, safe, reason };
}

export function saveImage(id: string, buf: Buffer): string {
  const file = path.join(imagesDir, `${id}.png`);
  fs.writeFileSync(file, buf);
  return file;
}

/** Placeholder coin image (initials on a gradient) when the post has no picture at all. */
export async function placeholderImage(ticker: string): Promise<Buffer> {
  const letters = ticker.slice(0, 4);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#C6F432"/><stop offset="1" stop-color="#1FAA59"/></linearGradient></defs>
    <rect width="512" height="512" fill="url(#g)"/>
    <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="${letters.length > 3 ? 120 : 150}" fill="#0A0A0B">${letters}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
