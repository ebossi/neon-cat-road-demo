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
//
// Remove-ads purchase (ONE store rule): purchase() resolving is only a payment signal, not a reason to grant. The same
// game server verifies the purchaseToken with ONE store and acknowledges it (a managed product kept forever: never
// consumed; ONE store refunds purchases left unacknowledged for 3 days), and the game grants only on its answer.
// A purchase the server could not check yet is kept in localStorage and verified again on the next start / resume.
// At start the server's ledger also restores purchases (another device, its cron) and revokes refunded ones.

const PENDING_KEY = "neoncat:pendingRewards";     // [{requestId, at, claimKey}] watched but not yet confirmed by the server
const PLAYER_KEY = "neoncat:rewardPlayerId";      // stand-in player id when the app gives none
const PENDING_MAX_AGE = 3 * 24 * 60 * 60 * 1000;  // the server may purge requests after 3 days
const CLAIM_TRIES = 10, CLAIM_INTERVAL = 1200;    // ~11 s for the postback right after the ad
const SERVER_TIMEOUT = 8000;
const PURCHASES_KEY = "neoncat:pendingPurchases"; // [{id, productId, purchaseToken, playerId, at}] paid but not yet verified by the server
const PURCHASE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // by then the server's cron has acknowledged it (restored via status)
const NOT_FOUND_GRACE = 15 * 60 * 1000;            // a just-paid token ONE store does not list yet stays pending this long
const OWNED_KEY = "neoncat:storeOwnedAt";          // {gameProductId: ms} when the app last answered already_owned
const OWNED_GRACE = 3 * 24 * 60 * 60 * 1000;       // that long a refund in the server's ledger does not revoke it
const VERIFY_TRIES = 3, VERIFY_INTERVAL = 1500;
const REMOVE_ADS = "removingads";
const GAME_PRODUCTS = [REMOVE_ADS];               // what the game sells (game ids; conf.products maps them)

export async function start(host, settings) {
  const conf = Object.assign({
    sdkVersion: "v1.1.0",
    rewardedPlacementId: "",     // ONEconsole > 수익화 > 인앱 광고 (rewarded)
    interstitialPlacementId: "", // ONEconsole > 수익화 > 인앱 광고 (interstitial)
    rewardServer: "",            // game server base URL (no trailing slash): rewarded-ad SSV and purchase verification
    products: {},                // game product id -> ONEconsole in-app product id (managed product)
  }, settings || {});
  // Remove-ads active (the game reports it at boot and when granted): no interstitials are preloaded or shown.
  // Defined before anything is awaited, so the game's boot-time report always finds it.
  let adsRemoved = false;
  host.adsRemoved = () => { adsRemoved = true; return true; };
  const { createSDK } = await import(`https://h5sdk.onestore.net/lib/${conf.sdkVersion}/onestore-h5-sdk.min.js`);
  const sdk = createSDK();
  host.onestore = sdk;

  // ---- Lifecycle: registered before initializeAsync (events can arrive right after it) ----
  let checksReady = false; // set once the game has started; resumes before that have no rewards / purchases to check
  sdk.on("pause", (e) => host.emit("pause", (e && e.reason) || ""));
  sdk.on("resume", (e) => {
    if (e && typeof e.ringerSilent === "boolean") host.emit("ringerSilent", e.ringerSilent ? "1" : "0");
    host.emit("resume");
    if (checksReady) { reconcileRewards(); reconcilePurchases(); if (purchaseServer !== "on") checkPurchaseServer(); }
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
        preloadInterstitial();
        // Rewards confirmed after the last session ended (late postback, app closed while checking).
        checksReady = true;
        reconcileRewards();
        // Price for the confirm dialog; purchases left unverified, bought elsewhere or refunded.
        loadProductDetails();
        restorePurchases();
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
    try { requestId = (await serverApi("/v1/reward-requests", { playerId: serverPlayerId() })).requestId; }
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
  const claimApi = (p) => serverApi(`/v1/reward-requests/${encodeURIComponent(p.requestId)}/claim`,
    { playerId: serverPlayerId(), claimKey: p.claimKey || undefined });
  // POST (or GET without a body) to the game server (rewards and purchases). Throws on network errors, timeouts and
  // non-2xx (error.status, error.code = the server's {"error": code}, e.g. "not_configured").
  async function serverApi(path, body) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), SERVER_TIMEOUT);
    try {
      const res = await fetch(rewardServer + path, body === undefined ? { method: "GET", signal: abort.signal } : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: abort.signal,
      });
      if (!res.ok) {
        let code = "";
        try { code = String((await res.json()).error || ""); } catch (e) {}
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, code });
      }
      return await res.json();
    } finally { clearTimeout(timer); }
  }
  // ONE store's pseudonymous playerId; outside it (or if empty) a random id kept on this device. Also the purchase's
  // developerPayload, so the server can tie a purchase it finds on its own (cron) to this player.
  let fallbackPlayerId = "";
  function serverPlayerId() {
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

  const hasInterstitial = () => !!conf.interstitialPlacementId && sdk.ads.isSupported("interstitial");
  function preloadInterstitial() {
    if (!adsRemoved && hasInterstitial()) sdk.ads.loadInterstitial({ placementId: conf.interstitialPlacementId });
  }
  host.showInterstitialAd = () => {
    if (adsRemoved || !hasInterstitial()) return false;
    sdk.ads.showInterstitialAsync({ placementId: conf.interstitialPlacementId }).then(() => {
      host.emit("interstitialAdClosed"); // completed or failed: the game continues either way
      preloadInterstitial();
    });
    return true;
  };

  // ---- In-app purchase: remove-ads (managed product, acknowledged by the game server, never consumed) ----
  // Sold only when the game server says it verifies purchases (GET /v1/health "purchases": true; without its ONE store
  // IAP secrets nothing would acknowledge them and ONE store refunds them after 3 days) and interstitials are
  // configured (otherwise there is nothing to remove).
  let purchaseServer = "unknown"; // "on" | "off" (server says not set up) | "unknown" (not answered yet); asked again on resume
  let checkingServer = false;
  host.hasPurchases = () => purchaseServer === "on" && sdk.iap.isSupported() && !!rewardServer && hasInterstitial();
  async function checkPurchaseServer() {
    if (!rewardServer || !sdk.iap.isSupported() || checkingServer) return;
    checkingServer = true;
    let r;
    try { r = await serverApi("/v1/health"); }
    catch (e) { console.warn("[ONEstore] game server health failed", e && e.message); return; }
    finally { checkingServer = false; }
    setPurchaseServer(r && r.purchases === true ? "on" : "off");
  }
  function setPurchaseServer(state) {
    if (state === purchaseServer) return;
    purchaseServer = state;
    host.emit("purchasesReady"); // the game shows / hides the remove-ads button
    if (state === "on" && checksReady) loadProductDetails();
  }
  const notConfigured = (e) => { if (e && e.code === "not_configured") { setPurchaseServer("off"); return true; } return false; };
  checkPurchaseServer();
  const storeProductId = (id) => (conf.products || {})[id] || id;
  const gameProductId = (productId) => GAME_PRODUCTS.find((id) => storeProductId(id) === productId) || "";
  host.purchase = (id) => {
    if (!host.hasPurchases()) return false;
    const productId = storeProductId(id);
    const playerId = serverPlayerId(); // developerPayload: the server only grants the purchase to this player
    sdk.iap.purchase({ productId, developerPayload: playerId }).then(
      (r) => completePurchase(id, productId, playerId, r),
      (e) => {
        const reason = e && e.reason;
        // Remove-ads is never consumed, so "already owned" means this account bought it before (another
        // device, reinstall): re-grant it. That is also how a completed-but-ungranted purchase is recovered.
        const status = reason === "already_owned" ? "ok" : reason === "user_cancelled" ? "cancel" : "fail";
        if (status === "ok") { announced.add(id); noteOwned(id); }
        host.emit("purchaseResult", id + ":" + status);
      });
    return true;
  };
  // Paid: grant only once the game server has verified (and acknowledged) the purchaseToken with ONE store.
  // Listed as pending first, so a payment is not lost if the app closes or the server is down while verifying.
  const verifying = new Set(); // purchaseTokens being verified right after the payment (reconciliation leaves them alone)
  async function completePurchase(id, productId, playerId, r) {
    const purchaseToken = r && typeof r.purchaseToken === "string" ? r.purchaseToken : "";
    if (!purchaseToken) { host.emit("purchaseResult", id + ":fail"); return; }
    verifying.add(purchaseToken);
    addPendingPurchase({ id, productId, purchaseToken, playerId, at: Date.now() });
    let status = "pending";
    try {
      for (let i = 0; i < VERIFY_TRIES; i++) {
        if (i) await new Promise((resolve) => setTimeout(resolve, VERIFY_INTERVAL));
        let v;
        try { v = await verifyApi(productId, purchaseToken, playerId); }
        catch (e) { if (!notConfigured(e) && isRetryable(e)) continue; break; } // kept for a later start / resume
        // ONE store may not list a purchase the moment it is paid: "not_found" now stays pending (NOT_FOUND_GRACE).
        if (v && typeof v.granted === "boolean") { status = v.granted ? "ok" : v.reason === "not_found" ? "pending" : "fail"; break; }
      }
    } finally { verifying.delete(purchaseToken); }
    if (status !== "pending") removePendingPurchase(purchaseToken); // "fail": cancelled / another player
    if (status === "ok") announced.add(id);
    host.emit("purchaseResult", id + ":" + status); // "pending": not granted yet, "purchaseRestored" follows later
  }
  // Verified for the player named in the purchase's developerPayload, even if this device's id changed since.
  const verifyApi = (productId, purchaseToken, playerId) => serverApi("/v1/purchases/verify",
    { playerId: typeof playerId === "string" && playerId ? playerId : serverPlayerId(), productId, purchaseToken });
  const isRetryable = (e) => !(e && e.status) || e.status >= 500 || e.status === 429; // network, timeout, 5xx
  // Verifies purchases paid but not confirmed yet (server was down, app closed). One at a time; the server answers
  // the same token idempotently, and each entry is announced at most once.
  let reconcilingPurchases = false, reconcilePurchasesAgain = false;
  async function reconcilePurchases() {
    if (!rewardServer) return;
    if (reconcilingPurchases) { reconcilePurchasesAgain = true; return; }
    reconcilingPurchases = true;
    try {
      do {
        reconcilePurchasesAgain = false;
        for (const p of readPendingPurchases()) {
          if (verifying.has(p.purchaseToken)) continue;
          if (!(Date.now() - p.at < PURCHASE_MAX_AGE)) { removePendingPurchase(p.purchaseToken); continue; }
          let v;
          try { v = await verifyApi(p.productId, p.purchaseToken, p.playerId); } catch (e) { notConfigured(e); continue; } // offline: next resume
          if (!v || typeof v.granted !== "boolean") continue;
          if (!v.granted && v.reason === "not_found" && Date.now() - p.at < NOT_FOUND_GRACE) continue; // not listed at ONE store yet
          removePendingPurchase(p.purchaseToken);
          if (v.granted) restored(p.id);
        }
      } while (reconcilePurchasesAgain);
    } finally { reconcilingPurchases = false; }
  }
  // At start: what the server's ledger says this player owns (another device, verified by its cron) or got refunded.
  async function restorePurchases() {
    if (!rewardServer) return;
    await reconcilePurchases();
    let r;
    try { r = await serverApi("/v1/purchases/status", { playerId: serverPlayerId() }); }
    catch (e) { notConfigured(e); console.warn("[ONEstore] purchase status failed", e && e.message); return; }
    const list = (v) => (Array.isArray(v) ? v.filter((p) => typeof p === "string") : []);
    const owned = list(r && r.owned);
    owned.forEach((p) => restored(gameProductId(p)));
    // A refund in the ledger is about an older purchase when this device holds a newer one the server has not
    // verified yet, or ONE store itself just reported the product owned (already_owned): no revoke then.
    const paidHere = (id) => readPendingPurchases().some((e) => e.id === id) || Date.now() - ownedAt(id) < OWNED_GRACE;
    list(r && r.voided).filter((p) => !owned.includes(p)).map(gameProductId).filter((id) => !paidHere(id)).forEach(revoked);
  }
  function readOwned() {
    let map = null;
    try { map = JSON.parse(localStorage.getItem(OWNED_KEY) || "{}"); } catch (e) {}
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  }
  function noteOwned(id) {
    const map = readOwned();
    map[id] = Date.now();
    try { localStorage.setItem(OWNED_KEY, JSON.stringify(map)); } catch (e) {}
  }
  const ownedAt = (id) => { const at = readOwned()[id]; return typeof at === "number" ? at : 0; };
  // Announces a purchase the game does not have yet. Remove-ads is skipped once the game reports it active, so the
  // "ads removed" notice does not repeat at every start.
  const announced = new Set();
  function restored(id) {
    if (!id || announced.has(id) || (id === REMOVE_ADS && adsRemoved)) return;
    announced.add(id);
    host.emit("purchaseRestored", id);
  }
  // Refunded (청약철회) while the game still has it: take remove-ads back (once; ads come back from now on).
  function revoked(id) {
    if (!(id === REMOVE_ADS && adsRemoved)) return;
    adsRemoved = false;
    announced.delete(id);
    host.emit("purchaseRevoked", id);
    preloadInterstitial();
  }
  // Store price for the confirm dialog (game ids): [{id, price, currency, amount}]. price is the store's display string
  // (it may or may not carry a currency sign or separators); amount = priceAmountMicros / 1e6 as a plain number.
  // Without it the dialog shows no price.
  let productDetailsAsked = false;
  function loadProductDetails() {
    if (productDetailsAsked || !host.hasPurchases() || !sdk.iap.isSupported("getProductDetails")) return;
    productDetailsAsked = true;
    sdk.iap.getProductDetailsAsync(GAME_PRODUCTS.map(storeProductId)).then((products) => {
      const details = [];
      for (const p of Array.isArray(products) ? products : []) {
        const id = p ? gameProductId(p.productId) : "";
        const micros = p ? Number(p.priceAmountMicros) : 0;
        if (id && p.price) details.push({ id, price: String(p.price), currency: String(p.priceCurrencyCode || ""),
          amount: micros > 0 ? String(micros / 1e6) : "" });
      }
      if (details.length) host.emit("productDetails", JSON.stringify(details));
    }, (e) => console.warn("[ONEstore] product details failed", e && e.reason));
  }
  function readPendingPurchases() {
    try {
      const list = JSON.parse(localStorage.getItem(PURCHASES_KEY) || "[]");
      return Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && typeof p.productId === "string"
        && typeof p.purchaseToken === "string" && p.purchaseToken && typeof p.at === "number") : [];
    } catch (e) { return []; }
  }
  function writePendingPurchases(list) {
    try { if (list.length) localStorage.setItem(PURCHASES_KEY, JSON.stringify(list)); else localStorage.removeItem(PURCHASES_KEY); } catch (e) {}
  }
  function addPendingPurchase(entry) {
    writePendingPurchases(readPendingPurchases().filter((p) => p.purchaseToken !== entry.purchaseToken).concat(entry).slice(-20));
  }
  function removePendingPurchase(purchaseToken) {
    writePendingPurchases(readPendingPurchases().filter((p) => p.purchaseToken !== purchaseToken));
  }

  // The engine waits at most 4 s for this adapter. If initializeAsync answered later, the game booted without these
  // hooks: let it re-check the remove-ads button, and start now if the title is already up.
  host.emit("purchasesReady");
  if (host.readyMs) host.__onTitleReady();
}
