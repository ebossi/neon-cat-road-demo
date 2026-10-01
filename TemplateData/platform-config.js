// Platform settings for the HTML5 build. Editable after deployment (no Unity rebuild needed).
window.NeonCatConfig = Object.assign({
  onestore: {
    sdkVersion: "v1.1.0",
    // Issued in ONEconsole > Apps > (game) > 수익화 > 인앱 광고, one per ad type. Empty = that ad type is off.
    rewardedPlacementId: "",
    interstitialPlacementId: "",
    // Game product id -> ONEconsole in-app product id (수익화 > 인앱 상품, managed product).
    products: { removingads: "removingads" },
  },
}, window.NeonCatConfig || {});
