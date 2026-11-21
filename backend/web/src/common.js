import { createPublicClient, createWalletClient, custom, http, formatEther } from "viem";
import { robinhood, robinhoodTestnet } from "viem/chains";

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let cfgPromise;
export function getConfig() {
  cfgPromise ??= fetch("/api/config").then((r) => r.json());
  return cfgPromise;
}
export async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

// ------------------------------------------------------------------ formatting

export const compact = (n) => (n == null ? "" : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n));
export function eth(wei, digits = 4) {
  if (wei == null) return "–";
  const v = Number(formatEther(BigInt(wei)));
  if (v === 0) return "0";
  if (v < 0.0001) return "<0.0001";
  return v.toLocaleString("en", { maximumFractionDigits: digits });
}
export function ago(ms) {
  if (!ms) return "";
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return new Date(ms).toLocaleDateString("en", { month: "short", day: "numeric" });
}
/** Tiny prices like 0.00000000227 become "0.0₈227" (zeros counted in subscript). */
export function tinyEth(wei) {
  const v = Number(formatEther(BigInt(wei)));
  if (v === 0) return "0";
  if (v >= 0.0001) return v.toPrecision(4);
  const zeros = Math.floor(-Math.log10(v)); // zeros right after the decimal point
  const digits = Math.round(v * 10 ** (zeros + 3)).toString().slice(0, 3);
  const sub = String(zeros).split("").map((d) => "₀₁₂₃₄₅₆₇₈₉"[d]).join("");
  return `0.0${sub}${digits}`;
}
export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
export const pct = (bps) => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`;

export function toast(msg, ms = 3200) {
  const t = $("#toast");
  if (!t) return alert(msg);
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), ms);
}

// ------------------------------------------------------------------ icons

export const ICON = {
  x: '<svg viewBox="0 0 24 24" class="xl" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
  check: '<svg viewBox="0 0 22 22" aria-label="Verified"><path fill="#1D9BF0" d="M20.4 11c0-1.3-.8-2.4-1.9-2.9.4-1.2.1-2.6-.8-3.5-.9-.9-2.3-1.2-3.5-.8C13.7 2.7 12.4 2 11 2s-2.7.7-3.2 1.8c-1.2-.4-2.6-.1-3.5.8-.9.9-1.2 2.3-.8 3.5C2.4 8.6 1.6 9.7 1.6 11s.8 2.4 1.9 2.9c-.4 1.2-.1 2.6.8 3.5.9.9 2.3 1.2 3.5.8.5 1.1 1.8 1.8 3.2 1.8s2.7-.7 3.2-1.8c1.2.4 2.6.1 3.5-.8.9-.9 1.2-2.3.8-3.5 1.1-.5 1.9-1.6 1.9-2.9z"/><path fill="#fff" d="M9.6 14.6 6.5 11.5l1.2-1.2 1.9 1.9 4.6-4.6 1.2 1.2z"/></svg>',
  reply: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M1.75 10c0-4.42 3.58-8 8-8h4.36c4.42 0 8 3.58 8 8 0 2.95-1.6 5.53-3.98 6.92L9.75 21.5v-3.5h-.01c-4.4-.03-7.99-3.6-7.99-8zm8-6c-3.31 0-6 2.69-6 6s2.69 6 6.01 6h1.99v2.1l5.36-2.97C18.73 14.1 20.11 12.13 20.11 10c0-3.31-2.69-6-6-6z"/></svg>',
  repost: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4.5 3.88l4.43 4.14-1.36 1.46L5.5 7.55V16c0 1.1.9 2 2 2H13v2H7.5c-2.21 0-4-1.79-4-4V7.55L1.43 9.48.07 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.21 0 4 1.79 4 4v8.45l2.07-1.93 1.36 1.46-4.43 4.14-4.43-4.14 1.36-1.46 2.07 1.93V8c0-1.1-.9-2-2-2z"/></svg>',
  like: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M16.7 5.5c-1.11-.03-2.3.5-3.58 2.06L12 8.92l-1.12-1.36C9.6 6 8.4 5.47 7.3 5.5 6.2 5.53 5.2 6.07 4.48 6.84 3.04 8.38 2.86 10.9 4.92 13.36c1.26 1.5 4.4 4.33 7.08 6.4 2.68-2.07 5.82-4.9 7.08-6.4 2.06-2.46 1.88-4.98.44-6.52-.72-.77-1.72-1.31-2.82-1.34z"/></svg>',
  views: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z"/></svg>',
};

// ------------------------------------------------------------------ X-style post card

/** Renders a real post returned by the API (never invented content). */
export function postCard(p, { tagLine = true, botHandle = "JustTag" } = {}) {
  const m = p.metrics;
  const media = p.thumb
    ? `<div class="md"><img loading="lazy" src="${esc(p.thumb)}" alt="" />${p.isVideo ? '<span class="play"></span>' : ""}</div>`
    : "";
  return `<article class="post">
    <header>
      <img class="av" loading="lazy" src="${esc(p.avatar)}" alt="" />
      <div class="who"><div class="nm">${esc(p.name)} ${p.verified ? ICON.check : ""}</div><div class="hd">@${esc(p.handle)}${p.created ? ` · ${ago(p.created)}` : ""}</div></div>
      <a href="${esc(p.url)}" target="_blank" rel="noopener" aria-label="Open on X">${ICON.x}</a>
    </header>
    <p class="tx">${esc((p.text || "").replace(/https:\/\/t\.co\/\w+$/, "").trim())}</p>
    ${media}
    ${m ? `<footer><span>${ICON.reply}${compact(m.replies)}</span><span>${ICON.repost}${compact(m.reposts)}</span><span>${ICON.like}${compact(m.likes)}</span>${m.views != null ? `<span>${ICON.views}${compact(m.views)}</span>` : ""}</footer>` : ""}
    ${tagLine ? `<div class="tagline"><span class="mention">@${esc(botHandle)}</span>${p.coin ? `<span class="coinpill"><i></i>$${esc(p.coin.symbol)}</span>` : ""}</div>` : ""}
  </article>`;
}

/** Example card used to explain the product. Clearly generic (@you / @poster), not a real post. */
export function exampleCard({ name, handle, text, reply, bot, children = "" }) {
  return `<article class="post ${reply ? "reply" : ""} ${bot ? "bot" : ""}">
    <header>
      <div class="av" style="display:grid;place-items:center;font-weight:800;${bot ? "background:#0A0A0B" : ""}">${bot ? '<img src="/img/logo.svg" width="40" height="40" alt="" style="border-radius:50%"/>' : esc(name[0])}</div>
      <div class="who"><div class="nm">${esc(name)}</div><div class="hd">@${esc(handle)} · now</div></div>${ICON.x}
    </header>
    ${reply ? `<div class="hd" style="margin-top:6px;color:#536471;font-size:14px">Replying to ${reply}</div>` : ""}
    <p class="tx">${text}</p>${children}
  </article>`;
}

// ------------------------------------------------------------------ page chrome

export async function initChrome() {
  const top = $(".top");
  if (top) addEventListener("scroll", () => top.classList.toggle("scrolled", scrollY > 8), { passive: true });

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { rootMargin: "0px 0px -8% 0px" });
  $$(".reveal").forEach((el) => io.observe(el));

  const cfg = await getConfig();
  $$("[data-bot]").forEach((el) => (el.textContent = `@${cfg.bot}`));
  $$("[data-x-link]").forEach((el) => (el.href = `https://x.com/${cfg.bot}`));
  $$("[data-explorer-link]").forEach((el) => (el.href = cfg.explorer));
  $$("[data-ca]").forEach((el) => {
    if (!cfg.ca) return;
    el.classList.remove("hidden");
    $("span", el).textContent = cfg.ca;
    el.addEventListener("click", async () => {
      await navigator.clipboard.writeText(cfg.ca).catch(() => {});
      el.classList.add("copied");
      setTimeout(() => el.classList.remove("copied"), 1500);
    });
  });
  return cfg;
}

// ------------------------------------------------------------------ wallet (Robinhood Chain)

let wallet = null;
export function chainFor(cfg) {
  const known = [robinhood, robinhoodTestnet].find((c) => c.id === cfg.chainId);
  return known ?? { ...robinhood, id: cfg.chainId, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
}
export function publicClientFor(cfg) {
  return createPublicClient({ chain: chainFor(cfg), transport: http(cfg.rpcUrl) });
}

/** Injected wallet discovery (EIP-6963), falling back to window.ethereum. Works with MetaMask, Rabby, Robinhood Wallet's browser. */
function discoverProvider() {
  return new Promise((resolve) => {
    const found = [];
    const onAnnounce = (e) => found.push(e.detail);
    addEventListener("eip6963:announceProvider", onAnnounce);
    dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      removeEventListener("eip6963:announceProvider", onAnnounce);
      const rh = found.find((d) => /robinhood/i.test(d.info?.name ?? ""));
      resolve((rh ?? found[0])?.provider ?? window.ethereum ?? null);
    }, 250);
  });
}

export async function connectWallet(cfg) {
  if (wallet) return wallet;
  const provider = await discoverProvider();
  if (!provider) throw new Error("No wallet found. Install MetaMask or open this page in Robinhood Wallet's browser.");
  const chain = chainFor(cfg);
  const [address] = await provider.request({ method: "eth_requestAccounts" });
  const hexId = `0x${chain.id.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e) {
    if (e.code === 4902 || /unrecognized|not added/i.test(e.message ?? "")) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hexId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [cfg.rpcUrl],
          blockExplorerUrls: [cfg.explorer],
        }],
      });
    } else throw e;
  }
  const client = createWalletClient({ account: address, chain, transport: custom(provider) });
  wallet = { address, client, provider };
  provider.on?.("accountsChanged", () => location.reload());
  return wallet;
}
export const connectedWallet = () => wallet;
