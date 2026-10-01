// ONE store H5 Game SDK adapter (HTML5 build). Loaded by index.html only when the page runs inside the ONE store
// app (?platform=onestore in the registered URL, or a ONE store ancestor frame). It maps the SDK onto the
// window.NeonCatHost hooks the game already uses for ads, purchases, back key and lifecycle (docs/WEB_BUILD.md).
// SDK guide: https://onestore-dev.gitbook.io/dev/tools/web-sdk
//
// Flow: listeners -> initializeAsync -> (Unity loads) setLoadingProgress -> title ready -> startGameAsync.
// In a regular browser initializeAsync resolves with `err`; the game then simply runs without ONE store features.

export async function start(host, settings) {
  const conf = Object.assign({
    sdkVersion: "v1.1.0",
    rewardedPlacementId: "",     // ONEconsole > 수익화 > 인앱 광고 (rewarded)
    interstitialPlacementId: "", // ONEconsole > 수익화 > 인앱 광고 (interstitial)
    products: {},                // game product id -> ONEconsole in-app product id (managed product)
  }, settings || {});
  const { createSDK } = await import(`https://h5sdk.onestore.net/lib/${conf.sdkVersion}/onestore-h5-sdk.min.js`);
  const sdk = createSDK();
  host.onestore = sdk;

  // ---- Lifecycle: registered before initializeAsync (events can arrive right after it) ----
  sdk.on("pause", (e) => host.emit("pause", (e && e.reason) || ""));
  sdk.on("resume", (e) => {
    if (e && typeof e.ringerSilent === "boolean") host.emit("ringerSilent", e.ringerSilent ? "1" : "0");
    host.emit("resume");
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
        if (conf.rewardedPlacementId && sdk.ads.isSupported("rewarded")) sdk.ads.loadRewarded({ placementId: conf.rewardedPlacementId });
        if (conf.interstitialPlacementId && sdk.ads.isSupported("interstitial")) sdk.ads.loadInterstitial({ placementId: conf.interstitialPlacementId });
      })
      .catch((e) => console.warn("[ONEstore] startGameAsync failed", e && e.reason));
  };

  // ---- Ads ----
  host.hasRewardedAd = () => !!conf.rewardedPlacementId && sdk.ads.isSupported("rewarded");
  host.showRewardedAd = () => {
    if (!host.hasRewardedAd()) return false;
    // Required by the SDK; identifies this request in the server-side (SSV) postback.
    const requestId = `${host.playerId || "guest"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    sdk.ads.showRewardedAsync({ placementId: conf.rewardedPlacementId, requestId }).then((r) => {
      if (r.status === "rewarded") host.emit("rewardedAdResult", "1");
      else if (r.status === "dismissed") host.emit("rewardedAdResult", "0"); // left early: no reward
      else host.emit("showRewardedAd:failed", r.reason || "failed");      // incl. no_fill: no reward
      sdk.ads.loadRewarded({ placementId: conf.rewardedPlacementId });
    });
    return true;
  };
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
