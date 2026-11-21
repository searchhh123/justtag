import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { app } from "./server.js";
import { xConfigured } from "./x/client.js";

const log = (...a: unknown[]) => console.log("[justtag]", ...a);

serve({ fetch: app.fetch, port: config.port }, () => log(`web + api on ${config.origin} (port ${config.port})`));

async function startWorkers() {
  const chainReady = !!config.launchpad;
  if (!chainReady) log("LAUNCHPAD_ADDRESS not set: workers are off until the contracts are deployed");
  if (chainReady && config.runIndexer) (await import("./indexer.js")).startIndexer();
  if (chainReady && config.runBot) {
    if (!xConfigured() || !config.operatorKey) log("bot off: needs X OAuth 1.0a keys and OPERATOR_PRIVATE_KEY");
    else (await import("./bot.js")).startBot().catch((e) => log("bot failed to start:", e.message));
  }
  if (chainReady && config.runAgents && config.operatorKey) (await import("./agents.js")).startAgents();
  if (chainReady && config.runPayouts && config.operatorKey) (await import("./payouts.js")).startPayouts();
}
startWorkers();
