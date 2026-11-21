import { formatEther, parseEther, parseUnits, formatUnits } from "viem";
import { launchpadAbi, tokenAbi } from "./abi.js";
import { $, $$, api, ago, connectWallet, connectedWallet, esc, eth, initChrome, pct, postCard, publicClientFor, short, tinyEth, toast } from "./common.js";

const cfg = await initChrome();
const id = location.pathname.split("/").pop();
const pub = publicClientFor(cfg);
const SLIPPAGE_BPS = 300n;
let side = "buy";
let data;

async function load() {
  try {
    data = await api(`/api/coin/${id}`);
  } catch (e) {
    $("#c-name").textContent = "Coin not found";
    return;
  }
  const { coin, curve, trades, holders } = data;
  document.title = `$${coin.symbol} · ${coin.name} · JustTag`;
  $("#c-img").src = coin.image;
  $("#c-name").textContent = coin.name;
  $("#c-ticker").textContent = `$${coin.symbol}`;
  $("#c-src").textContent = coin.source === "agent" ? "· launched by an agent" : coin.source === "pad" ? "· agent coin" : coin.tagger ? `· tagged by @${coin.tagger}` : "";

  const priceWei = curve ? (BigInt(curve.virtualEth) * 10n ** 18n) / BigInt(curve.virtualToken) : coin.priceWei ? BigInt(coin.priceWei) : null;
  $("#s-price").textContent = priceWei != null ? `Ξ ${tinyEth(priceWei)}` : "–";
  $("#s-mcap").textContent = priceWei != null ? `Ξ ${eth(priceWei * 1_000_000_000n, 2)}` : "–";
  $("#s-raised").textContent = curve ? `Ξ ${eth(curve.realEth, 3)}` : "–";
  $("#s-holders").textContent = holders ?? "–";
  if (curve) {
    $("#s-progress").style.width = `${curve.graduated ? 100 : curve.progress}%`;
    $("#s-progress-text").textContent = curve.graduated ? "· graduated to Uniswap" : `· ${curve.progress.toFixed(1)}% sold`;
  }
  if (coin.graduated || curve?.graduated) {
    $("#s-grad-note").innerHTML = `This coin graduated. Its liquidity is in a Uniswap V2 pool on Robinhood Chain (<a class="mention" target="_blank" rel="noopener" href="${cfg.explorer}/address/${esc(coin.pair)}">pool</a>), LP burned.`;
    $("#trade").innerHTML = `<b>Graduated</b><p class="muted">Trade $${esc(coin.symbol)} on Uniswap (Robinhood Chain).</p><a class="btn btn-ink btn-lg" style="width:100%" target="_blank" rel="noopener" href="${cfg.explorer}/token/${esc(coin.token)}">View token</a>`;
  }

  $("#c-post").innerHTML = coin.post ? postCard(coin.post, { tagLine: false }) : `<p class="muted">${esc(coin.description ?? "")}</p>`;
  $("#c-split").innerHTML = coin.split
    .map((s) => `<div><span>${s.handle ? `<a class="mention" href="https://x.com/${esc(s.handle)}" target="_blank" rel="noopener">@${esc(s.handle)}</a> <span class="muted">${esc(s.role)}</span>` : s.route ? `${esc(s.route[0].toUpperCase() + s.route.slice(1))} <span class="muted">route</span>` : short(s.wallet)}</span><b>${pct(s.bps)}</b></div>`)
    .join("");
  $("#c-trades").innerHTML = trades.length
    ? trades
        .map((t) => `<tr><td class="${t.is_buy ? "b" : "s"}">${t.is_buy ? "Buy" : "Sell"}</td><td>${eth(t.eth_wei)}</td><td>${Number(formatUnits(BigInt(t.token_amount), 18)).toLocaleString("en", { maximumFractionDigits: 0 })}</td><td><a target="_blank" rel="noopener" href="${cfg.explorer}/tx/${esc(t.tx_hash)}">${short(t.trader)}</a></td><td>${ago(t.ts)}</td></tr>`)
        .join("")
    : `<tr><td colspan="5" class="muted">No trades yet. Be first.</td></tr>`;
  drawChart(trades.slice().reverse());
  $("#l-explorer").href = `${cfg.explorer}/token/${coin.token}`;
}

function drawChart(trades) {
  const svg = $("#chart");
  if (trades.length < 2) {
    svg.innerHTML = `<text x="300" y="115" text-anchor="middle" fill="#868C83" font-size="15" font-family="sans-serif">The chart starts with the first trades</text>`;
    return;
  }
  const ys = trades.map((t) => Number(formatEther(BigInt(t.price_wei))));
  const min = Math.min(...ys), max = Math.max(...ys);
  const pts = ys.map((y, i) => `${(i / (ys.length - 1)) * 600},${200 - ((y - min) / (max - min || 1)) * 180}`);
  const up = ys[ys.length - 1] >= ys[0];
  const color = up ? "#00C805" : "#FF5000";
  svg.innerHTML = `<polyline fill="none" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke" points="${pts.join(" ")}"/>`;
}

// ------------------------------------------------------------------ trading

function setSide(s) {
  side = s;
  $$(".trade-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.side === s));
  $("#t-unit").textContent = s === "buy" ? "ETH" : `$${data?.coin.symbol ?? ""}`;
  $("#t-amount").value = "";
  $("#t-quick").innerHTML = s === "buy"
    ? ["0.01", "0.05", "0.1", "0.5"].map((v) => `<button class="btn btn-soft btn-sm" data-q="${v}">Ξ ${v}</button>`).join("")
    : ["25", "50", "100"].map((v) => `<button class="btn btn-soft btn-sm" data-pct="${v}">${v}%</button>`).join("");
  $$("[data-q]").forEach((b) => b.addEventListener("click", () => { $("#t-amount").value = b.dataset.q; quote(); }));
  $$("[data-pct]").forEach((b) => b.addEventListener("click", async () => {
    const w = await connectWallet(cfg);
    const bal = await pub.readContract({ address: data.coin.token, abi: tokenAbi, functionName: "balanceOf", args: [w.address] });
    $("#t-amount").value = formatUnits((bal * BigInt(b.dataset.pct)) / 100n, 18);
    quote();
  }));
  quote();
  refreshButton();
}
$$(".trade-tabs button").forEach((b) => b.addEventListener("click", () => setSide(b.dataset.side)));

let lastQuote = null;
async function quote() {
  lastQuote = null;
  const v = $("#t-amount").value.trim();
  if (!v || !cfg.launchpad || !data) return ($("#t-quote").textContent = "");
  try {
    if (side === "buy") {
      const wei = parseEther(v);
      const [out, fee] = await pub.readContract({ address: cfg.launchpad, abi: launchpadAbi, functionName: "quoteBuy", args: [data.coin.token, wei] });
      lastQuote = { in: wei, out };
      $("#t-quote").textContent = `≈ ${Number(formatUnits(out, 18)).toLocaleString("en", { maximumFractionDigits: 0 })} $${data.coin.symbol} · fee Ξ ${eth(fee, 6)}`;
    } else {
      const amt = parseUnits(v, 18);
      const [out, fee] = await pub.readContract({ address: cfg.launchpad, abi: launchpadAbi, functionName: "quoteSell", args: [data.coin.token, amt] });
      lastQuote = { in: amt, out };
      $("#t-quote").textContent = `≈ Ξ ${eth(out, 6)} · fee Ξ ${eth(fee, 6)}`;
    }
  } catch {
    $("#t-quote").textContent = "Enter a valid amount";
  }
}
$("#t-amount").addEventListener("input", quote);

function refreshButton() {
  const w = connectedWallet();
  $("#t-go").textContent = w ? (side === "buy" ? `Buy $${data?.coin.symbol ?? ""}` : `Sell $${data?.coin.symbol ?? ""}`) : "Connect wallet";
  $("#t-go").className = `btn btn-lg ${w ? (side === "buy" ? "btn-lime" : "btn-ink") : "btn-ink"}`;
}

$("#t-go").addEventListener("click", async () => {
  const btn = $("#t-go");
  try {
    const w = await connectWallet(cfg);
    if (!lastQuote) { refreshButton(); return; }
    btn.disabled = true;
    const minOut = (lastQuote.out * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    let hash;
    if (side === "buy") {
      btn.innerHTML = '<span class="spinner"></span> Confirm in wallet';
      hash = await w.client.writeContract({ address: cfg.launchpad, abi: launchpadAbi, functionName: "buy", args: [data.coin.token, minOut, w.address, deadline], value: lastQuote.in });
    } else {
      const allowance = await pub.readContract({ address: data.coin.token, abi: tokenAbi, functionName: "allowance", args: [w.address, cfg.launchpad] });
      if (allowance < lastQuote.in) {
        btn.innerHTML = '<span class="spinner"></span> Approve in wallet';
        const ah = await w.client.writeContract({ address: data.coin.token, abi: tokenAbi, functionName: "approve", args: [cfg.launchpad, lastQuote.in] });
        await pub.waitForTransactionReceipt({ hash: ah });
      }
      btn.innerHTML = '<span class="spinner"></span> Confirm in wallet';
      hash = await w.client.writeContract({ address: cfg.launchpad, abi: launchpadAbi, functionName: "sell", args: [data.coin.token, lastQuote.in, minOut, w.address, deadline] });
    }
    btn.innerHTML = '<span class="spinner"></span> Confirming';
    const r = await pub.waitForTransactionReceipt({ hash });
    toast(r.status === "success" ? "Done." : "Transaction reverted");
    $("#t-amount").value = "";
    setTimeout(load, 1500);
  } catch (e) {
    toast(e.shortMessage ?? e.message);
  } finally {
    btn.disabled = false;
    refreshButton();
  }
});

$("#l-copy").addEventListener("click", async (e) => {
  e.preventDefault();
  await navigator.clipboard.writeText(data?.coin.token ?? "").catch(() => {});
  toast("Address copied");
});

await load();
setSide("buy");
setInterval(load, 15_000);
