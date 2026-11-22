// Renders the brand kit into ../brand: X profile picture (400x400), X header (1500x500), square logo (1024).
import fs from "node:fs";
import sharp from "sharp";
const out = new URL("../../brand/", import.meta.url);
fs.mkdirSync(out, { recursive: true });
const FONT = "Arial Black, DejaVu Sans, Arial, sans-serif";
const tag = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M10.5 11.5h11.2l8.3 8.3-10.2 10.2-9.3-9.3z" fill="#C6F432"/><circle cx="16" cy="17" r="2.5" fill="#0A0A0B"/></g>`;

const logo = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40"><rect width="40" height="40" fill="#0A0A0B"/>${tag(-0.6, -1, 1)}</svg>`;
await sharp(Buffer.from(logo(400))).resize(400, 400).png().toFile(new URL("x-avatar-400.png", out).pathname.replace(/^\/(\w:)/, "$1"));
await sharp(Buffer.from(logo(1024))).resize(1024, 1024).png().toFile(new URL("logo-1024.png", out).pathname.replace(/^\/(\w:)/, "$1"));

const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500">
  <rect width="1500" height="500" fill="#FFFFFF"/>
  <text x="1420" y="250" text-anchor="end" font-family="${FONT}" font-weight="900" font-size="132" fill="#0A0A0B" letter-spacing="-7">Tag it.</text>
  <rect x="${1420 - 672}" y="330" width="672" height="40" rx="6" fill="#C6F432"/>
  <text x="1420" y="370" text-anchor="end" font-family="${FONT}" font-weight="900" font-size="132" fill="#0A0A0B" letter-spacing="-7">It's a coin.</text>
  <text x="1420" y="440" text-anchor="end" font-family="${FONT}" font-weight="700" font-size="28" fill="#3B4038">Reply under any post · Live on Robinhood Chain · $JUSTTAG</text>
</svg>`;
await sharp(Buffer.from(banner)).png().toFile(new URL("x-header-1500x500.png", out).pathname.replace(/^\/(\w:)/, "$1"));
fs.copyFileSync(new URL("../web/img/logo.svg", import.meta.url), new URL("logo.svg", out));
console.log("brand kit written to /brand");
