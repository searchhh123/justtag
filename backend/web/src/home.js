import { parseEther } from "viem";
import { parseTag } from "../../src/parse.ts";
import { $, $$, api, ago, connectWallet, esc, eth, exampleCard, initChrome, pct, postCard, toast } from "./common.js";

const cfg = await initChrome();
const BOT = cfg.bot;

// ------------------------------------------------------------------ hero wall (real posts only)

async function renderWall() {
  const wall = $("#wall");
  let posts = [];
  try {
    posts = (await api("/api/wall")).posts;
  } catch {}
  const cols = 4;
  const buckets = Array.from({ length: cols }, () => []);
  if (posts.length) {
    posts.forEach((p, i) => buckets[i % cols].push(postCard(p, { botHandle: BOT })));
    // make sure every column is tall enough to loop
    buckets.forEach((b, i) => { while (b.length && b.length < 4) b.push(...b.slice(0, 4 - b.length)); if (!b.length) b.push(...buckets[0]); });
  } else {
    const ghost = `<article class="post ghost"><header><div class="av"></div><div class="who"><div class="bar" style="width:60%;margin:0"></div><div class="bar" style="width:40%"></div></div></header><div class="bar"></div><div class="bar" style="width:80%"></div><div class="bar" style="height:120px;border-radius:14px"></div><div class="tagline"><span class="mention">@${esc(BOT)}</span></div></article>`;
    buckets.forEach((b) => b.push(ghost, ghost, ghost, ghost));
  }
  wall.innerHTML = buckets
    .map((b, i) => `<div class="col" style="--dur:${54 + i * 9}s">${b.join("")}${b.join("")}</div>`)
    .join("");
}
renderWall();

// ------------------------------------------------------------------ how it works conversation (illustrative)

$("#convo").innerHTML = [
  exampleCard({ name: "The Poster", handle: "poster", text: "A dog on a jet ski just rescued a guy stranded in the ocean. Internet's best boy." }),
  exampleCard({ name: "You", handle: "you", reply: '<span class="mention">@poster</span>', text: `<span class="mention">@${esc(BOT)}</span> 50/50` }),
  exampleCard({
    name: "JustTag", handle: BOT, bot: true, reply: '<span class="mention">@you</span> and <span class="mention">@poster</span>',
    text: `Live. $JETDOG is on JustTag (Robinhood Chain).\nCreator fees: 50% @you, 50% @poster. Sign in at ${esc(cfg.domain)}/claim to get paid.`,
  }),
  `<div class="payline"><div><b>@you</b>Creator fees · automatic</div><div><b>@poster</b>Creator fees · automatic</div></div>`,
].join("");

// ------------------------------------------------------------------ split builder (uses the bot's real parser)

const splitPost = { name: "The Poster", handle: "poster", text: "Cat jumps on the driver mid-chase and gets yeeted out the window. Driver doesn't even slow down." };
function renderSplit(tagText) {
  const r = parseTag(`@poster @${BOT} ${tagText}`, { bot: BOT, tagger: "you", poster: "poster" });
  $("#split-post").outerHTML = `<div id="split-post">${exampleCard({ name: splitPost.name, handle: splitPost.handle, text: esc(splitPost.text) })}
    ${exampleCard({ name: "You", handle: "you", reply: '<span class="mention">@poster</span>', text: `<span class="mention">@${esc(BOT)}</span> ${esc(tagText)}` })}</div>`;
  const label = { tagger: "the tagger", poster: "the poster", friend: "your friend" };
  $("#split-bars").innerHTML = r.split
    .map((s) => `<div class="bar-row"><div class="who">${s.role === "tagger" ? "You" : "@" + esc(s.handle)}<small>${label[s.role]}</small></div><div class="pct">${pct(s.bps)}</div><div class="track"><div class="fill" style="width:${s.bps / 100}%"></div></div></div>`)
    .join("");
  $("#split-meta").innerHTML = `
    <li><span>Name</span><b>${esc(r.name ?? "Cat In The Car")} <span class="muted">· ${r.name ? "yours" : "auto"}</span></b></li>
    <li><span>Ticker</span><b>$${esc(r.ticker ?? "CATCAR")} <span class="muted">· ${r.ticker ? "yours" : "auto"}</span></b></li>
    <li><span>Image</span><b>best picture <span class="muted">· auto</span></b></li>`;
}
$$("#split-chips .chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    $$("#split-chips .chip").forEach((c) => c.classList.toggle("on", c === chip));
    renderSplit(chip.dataset.tag);
  }),
);
renderSplit("50/50");

// ------------------------------------------------------------------ try it: live preview of a real post

$("#try-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("#try-url").value.trim();
  const tag = $("#try-tag").value.trim();
  const btn = $("#try-btn");
  const err = $("#try-err");
  err.classList.add("hidden");
  if (!url) return $("#try-url").focus();
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Reading the post';
  try {
    const r = await api("/api/preview", { url, tag });
    const img = r.image ? `<img src="${r.image}" alt="" />` : `<div class="coinimg">${esc(r.ticker.slice(0, 3))}</div>`;
    $("#try-result").innerHTML = `
      ${postCard(r.post, { tagLine: false })}
      <div class="coin-card">
        <div class="big">${img}<div><h3>${esc(r.name)}</h3><div class="tk">$${esc(r.ticker)}</div></div></div>
        <div class="row"><span>Image</span><span>${r.scores.length ? `best of ${r.scores.length} · ${r.scores[r.chosen] ?? "–"}/10` : "generated"}</span></div>
        <div class="row"><span>Creator fees</span><span>${esc(r.splitText.replaceAll("@you", "you"))}</span></div>
        <div class="row"><span>Chain</span><span>Robinhood Chain</span></div>
        ${r.existing ? `<a class="btn btn-lime btn-lg" href="/coin/${esc(r.existing.token)}">Already a coin: $${esc(r.existing.symbol)}</a>` : r.safe ? `<a class="btn btn-lime btn-lg" href="${esc(r.tagIntent)}" target="_blank" rel="noopener">Tag it for real</a>` : `<p class="err">JustTag won't launch this post.</p>`}
      </div>`;
    $("#try-result").classList.remove("hidden");
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Preview";
  }
});

// ------------------------------------------------------------------ pad: coin + agent

const ROUTES = [
  { k: "holders", t: "Holders", d: "airdropped to holders", v: 40 },
  { k: "owner", t: "You", d: "paid to your X account", v: 30 },
  { k: "buyback", t: "Buyback", d: "buys your coin", v: 30 },
  { k: "burn", t: "Burn", d: "buys and burns", v: 0 },
  { k: "authors", t: "Post authors", d: "the people it caught", v: 0 },
];
const pad = { preset: cfg.presets[0], image: null, routes: Object.fromEntries(ROUTES.map((r) => [r.k, r.v])) };

$("#pad-presets").innerHTML = cfg.presets.map((p, i) => `<button type="button" class="${i ? "" : "on"}" data-id="${p.id}">${esc(p.name)}${p.id !== "custom" ? " built in" : ""}</button>`).join("");
function renderPreset() {
  $$("#pad-presets button").forEach((b) => b.classList.toggle("on", b.dataset.id === pad.preset.id));
  $("#pad-sources").innerHTML = pad.preset.sources.map((s) => `<span>@${esc(s)}</span>`).join("");
  $("#pad-prompt").classList.toggle("hidden", pad.preset.id !== "custom");
  updatePreview();
}
$$("#pad-presets button").forEach((b) => b.addEventListener("click", () => { pad.preset = cfg.presets.find((p) => p.id === b.dataset.id); renderPreset(); }));

$("#pad-routes").innerHTML = ROUTES.map((r) => `<div class="route"><div><b>${r.t}</b><small>${r.d}</small></div><div class="val" data-val="${r.k}">${r.v}%</div><input type="range" min="0" max="100" step="5" value="${r.v}" data-route="${r.k}" aria-label="${r.t}" /></div>`).join("");
$$("[data-route]").forEach((inp) =>
  inp.addEventListener("input", () => {
    pad.routes[inp.dataset.route] = Number(inp.value);
    $(`[data-val="${inp.dataset.route}"]`).textContent = `${inp.value}%`;
    updatePreview();
  }),
);

$("#pad-img").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  pad.image = await downscale(f, 1024);
  $("#pad-img-drop").style.backgroundImage = `url(${pad.image})`;
  $("#pad-img-drop").firstChild.textContent = "";
  updatePreview();
});
["pad-name", "pad-ticker", "pad-prompt"].forEach((id) => $(`#${id}`).addEventListener("input", updatePreview));

function updatePreview() {
  const total = Object.values(pad.routes).reduce((a, b) => a + b, 0);
  const tot = $("#pad-total");
  tot.lastElementChild.textContent = `${total}%`;
  tot.classList.toggle("bad", total !== 100);
  $("#pv-name").textContent = $("#pad-name").value || "Your coin";
  $("#pv-ticker").textContent = "$" + ($("#pad-ticker").value.replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "TICKER");
  $("#pv-desc").textContent = pad.preset.id === "custom" ? $("#pad-prompt").value || "Write a prompt and your agent will launch coins for it." : pad.preset.prompt;
  $("#pv-img").outerHTML = pad.image ? `<img id="pv-img" src="${pad.image}" alt="" />` : `<div class="coinimg" id="pv-img">?</div>`;
  $("#pv-split").innerHTML = ROUTES.filter((r) => pad.routes[r.k] > 0).map((r) => `<div><b>${pad.routes[r.k]}%</b>${r.t}</div>`).join("");
}
renderPreset();

// "Watching" feed: the agent coins already running, else the coins launched most recently
(async () => {
  try {
    const { coins } = await api("/api/feed?limit=12");
    const items = coins.filter((c) => c.post).map((c) => `<p><b>@${esc(c.post.handle)}</b> ${esc(c.post.text.slice(0, 90))}</p>`);
    $("#pv-feed").innerHTML = items.length ? items.join("") + items.join("") : `<p>New posts from the sources show up here as your agent reads them.</p>`;
  } catch {}
})();

async function downscale(file, max) {
  const img = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.9);
}

let me = { signedIn: false };
api("/api/me").then((r) => {
  me = r;
  if (me.signedIn) {
    $("#pad-x").textContent = `Your share goes to @${me.handle}`;
    $("#pad-x").removeAttribute("href");
    renderMoney();
  }
}).catch(() => {});

$("#pad-connect").addEventListener("click", async () => {
  try {
    const w = await connectWallet(cfg);
    $("#pad-connect").textContent = `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;
  } catch (e) {
    toast(e.message);
  }
});

$("#pad-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#pad-err");
  err.classList.add("hidden");
  const btn = $("#pad-launch");
  try {
    if (!cfg.launchpad) throw new Error("JustTag's contracts are not deployed on this server yet.");
    const total = Object.values(pad.routes).reduce((a, b) => a + b, 0);
    if (total !== 100) throw new Error("The split has to add up to 100%.");
    const w = await connectWallet(cfg);
    $("#pad-connect").textContent = `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Preparing';
    const dev = $("#pad-devbuy").value.trim();
    const prep = await api("/api/pad/prepare", {
      name: $("#pad-name").value,
      ticker: $("#pad-ticker").value,
      image: pad.image,
      preset: pad.preset.id,
      prompt: $("#pad-prompt").value,
      routes: Object.fromEntries(Object.entries(pad.routes).map(([k, v]) => [k, v * 100])),
      wallet: w.address,
      devBuyWei: dev ? parseEther(dev).toString() : "0",
    });
    btn.innerHTML = '<span class="spinner"></span> Confirm in your wallet';
    const hash = await w.client.sendTransaction({ to: prep.to, data: prep.data, value: BigInt(prep.value) });
    btn.innerHTML = '<span class="spinner"></span> Launching on Robinhood Chain';
    const done = await api("/api/pad/submit", { agentId: prep.agentId, txHash: hash });
    toast("Live. Your agent is watching.");
    location.href = `/agent/${prep.agentId}?token=${done.token}`;
  } catch (ex) {
    err.textContent = ex.shortMessage ?? ex.message;
    err.classList.remove("hidden");
    btn.disabled = false;
    btn.textContent = "Launch coin + agent";
  }
});

// ------------------------------------------------------------------ money (your real balance when signed in)

function renderMoney() {
  if (!me.signedIn) {
    $("#money-acts").innerHTML = `<div class="act"><span>Sign in with X to see what your tags earned</span></div>`;
    return;
  }
  $("#money-bal").textContent = `Ξ ${eth(me.pending)}`;
  $("#money-acts").innerHTML = me.coins.slice(0, 5).map((c) => `<div class="act"><span>$${esc(c.symbol)}</span><b>creator fees</b></div>`).join("") || `<div class="act"><span>No coins yet. Tag a post!</span></div>`;
}
renderMoney();

// ------------------------------------------------------------------ live feed

async function renderLive() {
  let coins = [];
  try {
    coins = (await api("/api/feed?limit=12")).coins;
  } catch {}
  $("#live-grid").innerHTML = coins.length
    ? coins
        .map((c) => {
          const who = c.split.map((s) => (s.handle ? `${pct(s.bps)} @${esc(s.handle)}` : `${pct(s.bps)} ${esc(s.route ?? "wallet")}`)).slice(0, 2).join(" · ");
          return `<a class="livecoin" href="/coin/${esc(c.token)}">
            <div class="h"><img loading="lazy" src="${esc(c.image)}" alt="" /><div><b>$${esc(c.symbol)}</b><small>${esc(c.name)} · ${c.source === "agent" ? "agent" : c.source === "pad" ? "launchpad" : "tag"}</small></div></div>
            <p>${esc(c.post?.text ?? c.description ?? "")}</p>
            <div class="f"><span>${who}</span><span>${c.graduated ? "Uniswap" : ago(c.liveAt)}</span></div>
          </a>`;
        })
        .join("")
    : `<div class="empty"><b>No coins yet.</b><br />Be the first tag on JustTag.<br /><a class="btn btn-ink" href="#try">Tag a post</a></div>`;
}
renderLive();
setInterval(renderLive, 30_000);

