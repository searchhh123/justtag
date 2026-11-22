import fs from "node:fs";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { config } from "./config.js";
import type { CoinRow } from "./db.js";
import type { Recipient } from "./launcher.js";

/**
 * Share cards. X's link crawler does not run JavaScript, so coin pages get their title, description and
 * image tags rendered on the server, and every coin gets a 1200x630 preview image.
 */

const cardsDir = path.join(config.dataDir, "cards");
fs.mkdirSync(cardsDir, { recursive: true });

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const FONT = "DejaVu Sans, Arial, Helvetica, sans-serif";

function splitLine(c: CoinRow) {
  const split = JSON.parse(c.split_json) as Recipient[];
  return split
    .slice(0, 3)
    .map((s) => `${s.bps / 100}% ${s.handle ? "@" + s.handle : s.route ?? "wallet"}`)
    .join(" · ");
}

/** Cached per coin; rebuilt only if missing. */
export async function coinCard(c: CoinRow): Promise<Buffer> {
  const file = path.join(cardsDir, `${c.id}.png`);
  if (fs.existsSync(file)) return fs.readFileSync(file);

  const name = c.name.length > 18 ? c.name.slice(0, 17) + "…" : c.name;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <rect width="1200" height="630" fill="#FFFFFF"/>
    <rect x="0" y="560" width="1200" height="70" fill="#0A0A0B"/>
    <circle cx="300" cy="290" r="214" fill="#C6F432"/>
    <text x="580" y="200" font-family="${FONT}" font-weight="900" font-size="40" fill="#8FC000">$${xml(c.symbol)}</text>
    <text x="580" y="290" font-family="${FONT}" font-weight="900" font-size="72" fill="#0A0A0B" letter-spacing="-3">${xml(name)}</text>
    <text x="580" y="356" font-family="${FONT}" font-weight="700" font-size="28" fill="#3B4038">${xml(c.source === "agent" ? "Launched by an agent" : c.source === "pad" ? "Agent coin" : c.tagger ? "Tagged by @" + c.tagger : "Tagged on X")}</text>
    <text x="580" y="412" font-family="${FONT}" font-weight="700" font-size="22" fill="#868C83" letter-spacing="1">CREATOR FEES</text>
    ${(JSON.parse(c.split_json) as Recipient[])
      .slice(0, 3)
      .map((s, i) => {
        const who = s.handle ? "@" + s.handle : s.route ?? "wallet";
        const label = who.length > 26 ? who.slice(0, 25) + "…" : who;
        return `<text x="580" y="${452 + i * 36}" font-family="${FONT}" font-weight="700" font-size="28" fill="#3B4038"><tspan font-weight="900" fill="#0A0A0B">${s.bps / 100}%</tspan>  ${xml(label)}</text>`;
      })
      .join("")}
    <text x="60" y="605" font-family="${FONT}" font-weight="900" font-size="30" fill="#FFFFFF">JustTag</text>
    <text x="1140" y="605" text-anchor="end" font-family="${FONT}" font-weight="700" font-size="24" fill="#C6F432">Live on Robinhood Chain · ${xml(config.domain)}</text>
  </svg>`;

  const layers: OverlayOptions[] = [];
  if (c.image_path && fs.existsSync(c.image_path)) {
    const mask = Buffer.from(`<svg width="400" height="400"><circle cx="200" cy="200" r="200"/></svg>`);
    const round = await sharp(c.image_path).resize(400, 400).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
    layers.push({ input: round, left: 100, top: 90 });
  }
  const png = await sharp(Buffer.from(svg)).composite(layers).png().toBuffer();
  fs.writeFileSync(file, png);
  return png;
}

/** Inject per-coin <title>, description and Open Graph / Twitter tags into the coin page HTML. */
export function coinPageHtml(template: string, c: CoinRow): string {
  const title = `$${c.symbol} · ${c.name} · JustTag`;
  const desc = `${c.name} ($${c.symbol}) is live on Robinhood Chain. Creator fees: ${splitLine(c)}. Tag any post on X with @${config.botHandle} and it's a coin.`;
  const img = `${config.origin}/og/${c.id}.png`;
  const url = `${config.origin}/coin/${c.token}`;
  const tags = `
  <meta name="description" content="${xml(desc)}" />
  <meta property="og:title" content="${xml(title)}" />
  <meta property="og:description" content="${xml(desc)}" />
  <meta property="og:image" content="${img}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${xml(title)}" />
  <meta name="twitter:description" content="${xml(desc)}" />
  <meta name="twitter:image" content="${img}" />`;
  return template
    .replace(/<title>[^<]*<\/title>/, `<title>${xml(title)}</title>`)
    .replace(/\s*<meta name="description"[^>]*>/, "")
    .replace(/\s*<meta (property="og:|name="twitter:)[^>]*>/g, "")
    .replace("</head>", `${tags}\n</head>`);
}
