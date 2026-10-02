// Platform settings for the HTML5 build. Editable after deployment (no Unity rebuild needed).
window.NeonCatConfig = Object.assign({
  onestore: {
    sdkVersion: "v1.1.0",
    // Issued in ONEconsole > Apps > (game) > 수익화 > 인앱 광고, one per ad type. Empty = that ad type is off.
    rewardedPlacementId: "",
    interstitialPlacementId: "",
    // Reward server base URL, no trailing slash (e.g. "https://rewards.example.com"). It issues rewarded-ad
    // requestIds and receives ONE store's postback (SSV); its /onestore/reward-ad/webhook is the callback URL
    // registered in 수익화 > 인앱 광고. Empty = rewarded ads stay off (ONE store grants only after SSV).
    rewardServer: "",
    // Game product id -> ONEconsole in-app product id (수익화 > 인앱 상품, managed product).
    products: { removingads: "removingads" },
  },
}, window.NeonCatConfig || {});
