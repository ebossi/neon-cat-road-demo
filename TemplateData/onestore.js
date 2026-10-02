// ONE store H5 Game SDK adapter (HTML5 build). Loaded by index.html only when the page runs inside the ONE store
// app (?platform=onestore in the registered URL, or a ONE store ancestor frame). It maps the SDK onto the
// window.NeonCatHost hooks the game already uses for ads, purchases, back key and lifecycle (docs/WEB_BUILD.md).
// SDK guide: https://onestore-dev.gitbook.io/dev/tools/web-sdk
//
// Flow: listeners -> initializeAsync -> (Unity loads) setLoadingProgress -> title ready -> startGameAsync.
// In a regular browser initializeAsync resolves with `err`; the game then simply runs without ONE store features.
//
// Rewarded ads (ONE store rule): the SDK's "rewarded" is only a display signal, not a reason to grant. Our reward
// server issues the requestId, receives ONE store's server-to-server postback (SSV) and is asked (claim) before the
// game grants anything. A reward the server confirms only later is kept in localStorage and claimed on the next
// start / resume, then announced to the game as "rewardGranted".

const PENDING_KEY = "neoncat:pendingRewards";     // [{requestId, at, claimKey}] watched but not yet confirmed by the server
const PLAYER_KEY = "neoncat:rewardPlayerId";      // stand-in player id when the app gives none
const PENDING_MAX_AGE = 3 * 24 * 60 * 60 * 1000;  // the server may purge requests after 3 days
const CLAIM_TRIES = 10, CLAIM_INTERVAL = 1200;    // ~11 s for the postback right after the ad
const SERVER_TIMEOUT = 8000;

export async function start(host, settings) {
  const conf = Object.assign({
    sdkVersion: "v1.1.0",
    rewardedPlacementId: "",     // ONEconsole > 수익화 > 인앱 광고 (rewarded)
    interstitialPlacementId: "", // ONEconsole > 수익화 > 인앱 광고 (interstitial)
    rewardServer: "",            // reward server base URL (no trailing slash); without it rewarded ads stay off (SSV)
    products: {},                // game product id -> ONEconsole in-app product id (managed product)
  }, settings || {});
  const { createSDK } = await import(`https://h5sdk.onestore.net/lib/${conf.sdkVersion}/onestore-h5-sdk.min.js`);
  const sdk = createSDK();
  host.onestore = sdk;

  // ---- Lifecycle: registered before initializeAsync (events can arrive right after it) ----
  let rewardsReady = false; // set once the game has started; resumes before that have no rewards to check
  sdk.on("pause", (e) => host.emit("pause", (e && e.reason) || ""));
  sdk.on("resume", (e) => {
    if (e && typeof e.ringerSilent === "boolean") host.emit("ringerSilent", e.ringerSilent ? "1" : "0");
    host.emit("resume");
    if (rewardsReady) reconcileRewards();
  });
  // Only save (the game writes localStorage synchronously, well inside the 0.5 s budget). No quit() here.
  sdk.on("exit", () => host.emit("exit"));
  // Back key: must answer synchronously. The game closes its top layer; on the bare title it calls
  // NeonCatHost.exitApp(), and answering "not consumed" lets the app show its exit confirmation.
  let exitRequested = false;
  host.exitApp = () => { exitRequested = true; return true; };
  sdk.onBackPressed(() => {
    if (!host.unity) return false;
    exitRequested = false;
    host.emit("back");
    return !exitRequested;
  });

  let info;
  try { info = await sdk.initializeAsync(); }
  catch (e) { console.warn("[ONEstore] initializeAsync failed", e && e.reason); return; }
  if (!info || info.err) { console.log("[ONEstore] not inside the ONE store app:", info && info.err); return; }

  host.platform = "onestore";
  host.playerId = info.playerId || "";
  if (info.safeArea) host.setInsets(info.safeArea.top, info.safeArea.right, info.safeArea.bottom, info.safeArea.left);
  if (typeof info.ringerSilent === "boolean") host.emit("ringerSilent", info.ringerSilent ? "1" : "0");

  // ---- Loading progress, then start once the title screen is up ----
  let started = false;
  sdk.setLoadingProgress(0);
  host.__progress = (p) => { if (!started) sdk.setLoadingProgress(Math.round(p * 100)); };
  host.__onTitleReady = () => {
    if (started) return;
    started = true;
    sdk.setLoadingProgress(100);
    sdk.startGameAsync()
      .then(() => {
        // Preload so the first ad shows immediately when requested.
        if (host.hasRewardedAd()) sdk.ads.loadRewarded({ placementId: conf.rewardedPlacementId });
        if (conf.interstitialPlacementId && sdk.ads.isSupported("interstitial")) sdk.ads.loadInterstitial({ placementId: conf.interstitialPlacementId });
        // Rewards confirmed after the last session ended (late postback, app closed while checking).
        rewardsReady = true;
        reconcileRewards();
      })
      .catch((e) => console.warn("[ONEstore] startGameAsync failed", e && e.reason));
  };

  // ---- Ads ----
  const rewardServer = String(conf.rewardServer || "").replace(/\/+$/, "");
  host.hasRewardedAd = () => !!conf.rewardedPlacementId && !!rewardServer && sdk.ads.isSupported("rewarded");
  host.showRewardedAd = () => {
    if (!host.hasRewardedAd()) return false;
    showRewarded().catch((e) => {
      console.warn("[ONEstore] rewarded ad failed", e);
      host.emit("showRewardedAd:failed", "error");
    });
    return true;
  };
  async function showRewarded() {
    // 1) The reward server issues the requestId and maps it to this player (the postback carries only the id).
    let requestId = "";
    try { requestId = (await rewardApi("/v1/reward-requests", { playerId: rewardPlayerId() })).requestId; }
    catch (e) { console.warn("[ONEstore] reward request failed", e && e.message); }
    if (typeof requestId !== "string" || !requestId) { host.emit("showRewardedAd:failed", "server"); return; }
    // 2) Show it.
    const r = await sdk.ads.showRewardedAsync({ placementId: conf.rewardedPlacementId, requestId });
    // After a timeout the ad may still show late: no immediate re-request of that placement (ONE store guide).
    if (!(r && r.reason === "timeout")) sdk.ads.loadRewarded({ placementId: conf.rewardedPlacementId });
    if (r.status === "rewarded") {
      // 3) Watched: grant only once the server has the postback (it usually lands within seconds). Listed as
      // pending first, so a reward is not lost if the app is closed while checking.
      const pending = addPending(requestId);
      const claim = await claimReward(pending);
      if (claim === "granted") { removePending(requestId); host.emit("rewardedAdResult", "1"); }
      else if (claim === "pending") host.emit("rewardedAdPending"); // stays listed; "rewardGranted" comes later
      else { removePending(requestId); host.emit("showRewardedAd:failed", "claim_" + claim); } // never grantable
    } else if (r.status === "dismissed") host.emit("rewardedAdResult", "0"); // left early: no reward
    else {
      // incl. no_fill: no reward. After a timeout the ad may still show late; its postback is then claimed later.
      if (r && r.reason === "timeout") addPending(requestId);
      host.emit("showRewardedAd:failed", r.reason || "failed");
    }
  }
  const claiming = new Set(); // requestIds being polled right after their ad (reconciliation leaves them alone)
  async function claimReward(pending) {
    const requestId = pending.requestId;
    claiming.add(requestId);
    try {
      for (let i = 0; i < CLAIM_TRIES; i++) {
        if (i) await new Promise((resolve) => setTimeout(resolve, CLAIM_INTERVAL));
        let r;
        try { r = await claimApi(pending); } catch (e) { continue; } // network hiccup / lost answer: same key again
        if (r && r.granted === true) return "granted";
        if (r && isFinalClaim(r.status)) return r.status;
      }
      return "pending";
    } finally { claiming.delete(requestId); }
  }
  // Claims watched-but-unconfirmed rewards (late postbacks). The server grants each requestId at most once.
  let reconciling = false, reconcileAgain = false;
  async function reconcileRewards() {
    if (!rewardServer) return;
    if (reconciling) { reconcileAgain = true; return; }
    reconciling = true;
    try {
      do {
        reconcileAgain = false;
        for (const p of readPending()) {
          if (claiming.has(p.requestId)) continue;
          if (!(Date.now() - p.at < PENDING_MAX_AGE)) { removePending(p.requestId); continue; }
          let r;
          try { r = await claimApi(p); } catch (e) { continue; } // offline: keep it for the next resume
          if (r && r.granted === true) { removePending(p.requestId); host.emit("rewardGranted", "1"); }
          else if (r && isFinalClaim(r.status)) removePending(p.requestId);
        }
      } while (reconcileAgain);
    } finally { reconciling = false; }
  }
  const isFinalClaim = (status) => status === "claimed" || status === "unknown" || status === "mismatch";
  // claimKey makes a claim retry-safe: if the server granted but its answer was lost, asking again with the same key
  // answers granted again instead of "claimed". Each pending entry is granted at most once, so no double grant.
  const claimApi = (p) => rewardApi(`/v1/reward-requests/${encodeURIComponent(p.requestId)}/claim`,
    { playerId: rewardPlayerId(), claimKey: p.claimKey || undefined });
  async function rewardApi(path, body) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), SERVER_TIMEOUT);
    try {
      const res = await fetch(rewardServer + path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: abort.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timer); }
  }
  // ONE store's pseudonymous playerId; outside it (or if empty) a random id kept on this device.
  let fallbackPlayerId = "";
  function rewardPlayerId() {
    if (host.playerId) return host.playerId.slice(0, 128);
    if (fallbackPlayerId) return fallbackPlayerId;
    try { fallbackPlayerId = localStorage.getItem(PLAYER_KEY) || ""; } catch (e) {}
    if (!/^[\w-]{1,128}$/.test(fallbackPlayerId)) {
      fallbackPlayerId = "guest-" + randomHex(16);
      try { localStorage.setItem(PLAYER_KEY, fallbackPlayerId); } catch (e) {}
    }
    return fallbackPlayerId;
  }
  function randomHex(n) {
    return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  function readPending() {
    try {
      const list = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]");
      return Array.isArray(list) ? list.filter((p) => p && typeof p.requestId === "string" && typeof p.at === "number") : [];
    } catch (e) { return []; }
  }
  function writePending(list) {
    try { if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list)); else localStorage.removeItem(PENDING_KEY); } catch (e) {}
  }
  function addPending(requestId) {
    const list = readPending();
    const entry = list.find((p) => p.requestId === requestId) || { requestId, at: Date.now(), claimKey: randomHex(16) };
    writePending(list.filter((p) => p.requestId !== requestId).concat(entry).slice(-20));
    return entry;
  }
  function removePending(requestId) { writePending(readPending().filter((p) => p.requestId !== requestId)); }

  host.showInterstitialAd = () => {
    if (!conf.interstitialPlacementId || !sdk.ads.isSupported("interstitial")) return false;
    sdk.ads.showInterstitialAsync({ placementId: conf.interstitialPlacementId }).then(() => {
      host.emit("interstitialAdClosed"); // completed or failed: the game continues either way
      sdk.ads.loadInterstitial({ placementId: conf.interstitialPlacementId });
    });
    return true;
  };

  // ---- In-app purchase (managed products) ----
  host.hasPurchases = () => sdk.iap.isSupported();
  host.purchase = (id) => {
    const productId = conf.products[id] || id;
    sdk.iap.purchase({ productId, developerPayload: host.playerId.slice(0, 128) }).then(
      () => host.emit("purchaseResult", id + ":ok"),
      (e) => {
        const reason = e && e.reason;
        // Remove-ads is never consumed, so "already owned" means this account bought it before (another
        // device, reinstall): re-grant it. That is also how a completed-but-ungranted purchase is recovered.
        const status = reason === "already_owned" ? "ok" : reason === "user_cancelled" ? "cancel" : "fail";
        host.emit("purchaseResult", id + ":" + status);
      });
    return true;
  };
}
