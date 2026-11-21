// Renders web/img/og.png (1200x630 social card) from an SVG.
import sharp from "sharp";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="#FFFFFF"/>
  <rect x="80" y="80" width="84" height="84" rx="23" fill="#0A0A0B"/>
  <path d="M101 104h23.5l17.4 17.4-21.4 21.4-19.5-19.5z" fill="#C6F432"/><circle cx="112.6" cy="116.6" r="5.2" fill="#0A0A0B"/>
  <text x="186" y="140" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="46" fill="#0A0A0B" letter-spacing="-2">JustTag</text>
  <text x="80" y="330" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="128" fill="#0A0A0B" letter-spacing="-7">Tag it.</text>
  <rect x="76" y="420" width="664" height="40" rx="6" fill="#C6F432"/>
  <text x="80" y="460" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="128" fill="#0A0A0B" letter-spacing="-7">It's a coin.</text>
  <text x="80" y="550" font-family="Arial, sans-serif" font-weight="700" font-size="30" fill="#3B4038">Reply @JustTag under any post. Live on Robinhood Chain in seconds.</text>
</svg>`;
await sharp(Buffer.from(svg)).png().toFile("web/img/og.png");
console.log("web/img/og.png written");
