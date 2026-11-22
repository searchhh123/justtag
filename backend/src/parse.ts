/**
 * Turns the text of a tag into a deal.
 *
 *   @JustTag                    -> 50% tagger / 50% poster (100% if you tag your own post)
 *   @JustTag 50/50              -> same, explicit
 *   @JustTag 70/30              -> 70% tagger / 30% poster
 *   @JustTag all mine           -> 100% tagger
 *   @JustTag all to the poster  -> 100% poster
 *   @JustTag 50/50 @friend      -> 50% tagger / 50% @friend
 *   @JustTag 40/30/30 @a @b     -> 40% tagger / 30% @a / 30% @b
 *   @JustTag $CATCAR Cat Jumps  -> override ticker and name (split rules still apply)
 */

export type Role = "tagger" | "poster" | "friend";
export type Share = { handle: string; bps: number; role: Role };
export type ParsedTag = {
  split: Share[];
  ticker?: string;
  name?: string;
  explicitSplit: boolean;
};

const lower = (h: string) => h.replace(/^@/, "").toLowerCase();

export function parseTag(text: string, opts: { bot: string; tagger: string; poster: string }): ParsedTag {
  const bot = lower(opts.bot);
  const tagger = lower(opts.tagger);
  const poster = lower(opts.poster);

  // Drop the leading reply mentions X adds automatically and every mention of the bot.
  let body = text.replace(/https?:\/\/\S+/g, " ");
  body = body.replace(new RegExp(`@${bot}\\b`, "gi"), " ");

  // Ticker + name: "$TICKER Optional Name Words"
  let ticker: string | undefined;
  let name: string | undefined;
  const tm = body.match(/\$([A-Za-z][A-Za-z0-9]{0,11})\b([^@\n$]*)/);
  if (tm) {
    ticker = tm[1].toUpperCase();
    const n = tm[2]
      .replace(/\b\d{1,3}(\s*\/\s*\d{1,3})+\b/g, " ")
      .replace(/\ball\s+(mine|to\s+(the\s+)?poster|poster)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (n) name = n.slice(0, 32);
    // remove only the ticker and the name words; keep any ratio / keywords / friends for the split
    body = body.replace(`$${tm[1]}`, " ");
    if (n) body = body.replace(n, " ");
  }

  const ratio = body.match(/\b(\d{1,3}(?:\s*\/\s*\d{1,3}){1,5})\b/);
  const allMine = /\ball\s+mine\b|\b100\s*%?\s*(me|mine)\b/i.test(body);
  const allPoster = /\ball\s+(to\s+(the\s+)?)?(poster|op|author|them)\b/i.test(body);

  // Friends get a share only when they are mentioned after the ratio. X prepends "@poster @others" to replies
  // automatically, so a plain reply in a thread must not hand fees to everyone in it.
  const afterDeal = ratio ? body.slice(body.indexOf(ratio[0])) : "";
  const dealFriends = [...afterDeal.matchAll(/@(\w{1,15})/g)]
    .map((m) => m[1].toLowerCase())
    .filter((h) => h !== bot && h !== tagger && h !== poster);

  let shares: Share[];
  let explicit = true;
  if (allMine) {
    shares = [{ handle: tagger, bps: 10_000, role: "tagger" }];
  } else if (allPoster) {
    shares = [{ handle: poster, bps: 10_000, role: "poster" }];
  } else if (ratio) {
    const parts = ratio[1].split("/").map((p) => Number(p.trim()));
    const sum = parts.reduce((a, b) => a + b, 0);
    if (sum <= 0) {
      shares = defaultSplit(tagger, poster);
      explicit = false;
    } else {
      // first number = tagger, then each friend in order, anything left over = poster
      const recipients: { handle: string; role: Role }[] = [{ handle: tagger, role: "tagger" }];
      for (let i = 1; i < parts.length; i++) {
        const f = dealFriends[i - 1];
        recipients.push(f ? { handle: f, role: "friend" } : { handle: poster, role: "poster" });
      }
      shares = toBps(recipients.map((r, i) => ({ ...r, weight: parts[i] })), sum);
    }
  } else {
    shares = defaultSplit(tagger, poster);
    explicit = false;
  }

  return { split: merge(shares), ticker, name, explicitSplit: explicit };
}

function defaultSplit(tagger: string, poster: string): Share[] {
  if (tagger === poster) return [{ handle: tagger, bps: 10_000, role: "tagger" }];
  return [
    { handle: tagger, bps: 5_000, role: "tagger" },
    { handle: poster, bps: 5_000, role: "poster" },
  ];
}

function toBps(items: { handle: string; role: Role; weight: number }[], sum: number): Share[] {
  const out = items.map((i) => ({ handle: i.handle, role: i.role, bps: Math.floor((i.weight * 10_000) / sum) }));
  const dust = 10_000 - out.reduce((a, b) => a + b.bps, 0);
  out[0].bps += dust;
  return out.filter((s) => s.bps > 0);
}

/** Same handle twice (e.g. tagging your own post with 70/30) collapses into one share. */
function merge(shares: Share[]): Share[] {
  const map = new Map<string, Share>();
  for (const s of shares) {
    const prev = map.get(s.handle);
    if (prev) prev.bps += s.bps;
    else map.set(s.handle, { ...s });
  }
  return [...map.values()].slice(0, 6);
}

/** Human summary for the bot's reply: "50% @you, 50% @poster". */
export function describeSplit(split: { handle: string; bps: number }[]): string {
  return split.map((s) => `${(s.bps / 100).toFixed(s.bps % 100 ? 1 : 0)}% @${s.handle}`).join(", ");
}

/** Pull a post id out of an x.com / twitter.com link, or accept a bare id. */
export function postIdFromUrl(input: string): string | null {
  const s = input.trim();
  if (/^\d{5,25}$/.test(s)) return s;
  const m = s.match(/(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d{5,25})/i);
  return m ? m[1] : null;
}

/** "@JustTag opt out" / "@JustTag opt in", with nothing else in the post. */
export function parseCommand(text: string): "optout" | "optin" | null {
  const body = text.replace(/https?:\/\/\S+/g, "").replace(/@\w{1,15}/g, "").trim().toLowerCase();
  if (/^opt[\s-]?out[.!]*$/.test(body)) return "optout";
  if (/^opt[\s-]?in[.!]*$/.test(body)) return "optin";
  return null;
}
