// Bundles web/src/*.js (and the shared tag parser) into web/dist for the browser.
import { build } from "esbuild";
await build({
  entryPoints: ["web/src/home.js", "web/src/coin.js", "web/src/claim.js", "web/src/agent.js"],
  outdir: "web/dist",
  bundle: true,
  format: "esm",
  target: "es2022",
  splitting: true,
  minify: true,
  sourcemap: true,
  logLevel: "info",
});
