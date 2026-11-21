import { isAddress } from "viem";
import { $, api, connectWallet, esc, eth, initChrome, pct, toast } from "./common.js";

const cfg = await initChrome();
const params = new URLSearchParams(location.search);
if (params.get("error")) {
  $("#signed-out").insertAdjacentHTML("beforeend", `<p class="err">${esc(params.get("error"))}</p>`);
}
if (!cfg.xLogin) {
  $("#x-login").classList.add("hidden");
  $("#signed-out").insertAdjacentHTML("beforeend", `<p class="muted">X sign-in is not configured on this server yet.</p>`);
}

async function load() {
  const me = await api("/api/me");
  if (!me.signedIn) return;
  $("#signed-out").classList.add("hidden");
  $("#signed-in").classList.remove("hidden");
  $("#me-av").src = me.avatar ?? `/api/av/${me.handle}`;
  $("#me-name").textContent = me.name ?? me.handle;
  $("#me-handle").textContent = `@${me.handle}`;
  $("#me-bal").textContent = `Ξ ${eth(me.pending, 6)}`;
  if (me.wallet) {
    $("#bound").classList.remove("hidden");
    $("#bound").innerHTML = `Linked to <span class="mono">${esc(me.wallet)}</span>. New fees are sent there automatically.`;
    $("#wallet").value = me.wallet;
    $("#bind").textContent = "Change wallet";
  }
  $("#me-coins").innerHTML = me.coins.length
    ? me.coins.map((c) => {
        const mine = c.split.find((s) => s.handle === me.handle);
        return `<div><a href="/coin/${esc(c.token)}"><b>$${esc(c.symbol)}</b> <span class="muted">${esc(c.name)}</span></a><b>${mine ? pct(mine.bps) : ""}</b></div>`;
      }).join("")
    : `<p class="muted">No coins pay @${esc(me.handle)} yet. Tag a post or get tagged.</p>`;
}

$("#use-connected").addEventListener("click", async () => {
  try {
    const w = await connectWallet(cfg);
    $("#wallet").value = w.address;
  } catch (e) {
    toast(e.message);
  }
});

$("#bind").addEventListener("click", async () => {
  const wallet = $("#wallet").value.trim();
  const err = $("#claim-err");
  err.classList.add("hidden");
  if (!isAddress(wallet)) {
    err.textContent = "Enter a valid wallet address.";
    return err.classList.remove("hidden");
  }
  const btn = $("#bind");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Linking on Robinhood Chain';
  try {
    const r = await api("/api/bind", { wallet });
    if (r.signature) {
      // No operator on this server: submit the attester signature from the user's own wallet.
      const { launchpadAbi } = await import("./abi.js");
      const w = await connectWallet(cfg);
      const s = r.signature;
      await w.client.writeContract({ address: cfg.launchpad, abi: launchpadAbi, functionName: "bindWallet", args: [s.key, s.wallet, BigInt(s.deadline), s.signature] });
      await w.client.writeContract({ address: cfg.launchpad, abi: launchpadAbi, functionName: "claim", args: [s.key] });
    }
    toast("Linked. Your fees are on the way.");
    await load();
  } catch (e) {
    err.textContent = e.shortMessage ?? e.message;
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Link wallet and get paid";
  }
});

$("#logout").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  location.reload();
});

load();
