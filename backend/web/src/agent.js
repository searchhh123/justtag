import { $, api, ago, esc, initChrome, pct } from "./common.js";

await initChrome();
const id = location.pathname.split("/").pop();

const NAMES = { holders: "Holders", owner: "You", buyback: "Buyback", burn: "Burn", authors: "Post authors" };

async function load() {
  let a;
  try {
    a = await api(`/api/pad/status/${id}`);
  } catch {
    $("#a-title").textContent = "Agent not found";
    return;
  }
  const coin = a.token ? (await api(`/api/coin/${a.token}`).catch(() => null))?.coin : null;
  $("#a-title").textContent = coin ? `${coin.name} · $${coin.symbol}` : "Your agent";
  $("#a-prompt").textContent = a.prompt;
  $("#a-routes").innerHTML = Object.entries(a.routes).filter(([, v]) => v > 0).map(([k, v]) => `<div><span>${NAMES[k] ?? k}</span><b>${pct(v)}</b></div>`).join("");
  if (a.token) $("#a-coin").href = `/coin/${a.token}`;
  $("#a-launched").innerHTML = a.launched.length
    ? a.launched.map((c) => `<a class="livecoin" href="/coin/${esc(c.token)}"><div class="h"><img src="${esc(c.image)}" alt="" /><div><b>$${esc(c.symbol)}</b><small>${esc(c.name)}</small></div></div><p>${esc(c.post?.text ?? "")}</p><div class="f"><span>from @${esc(c.post?.handle ?? "")}</span><span>${ago(c.liveAt)}</span></div></a>`).join("")
    : `<div class="empty">Nothing yet. Your agent launches the moment a post matches its brief.</div>`;
}
load();
setInterval(load, 30_000);
