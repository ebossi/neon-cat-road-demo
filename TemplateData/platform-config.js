// Platform settings for the HTML5 build. Editable after deployment (no Unity rebuild needed).
window.NeonCatConfig = Object.assign({
  onestore: {
    sdkVersion: "v1.1.0",
    // Issued in ONEconsole > Apps > (game) > 수익화 > 인앱 광고, one per ad type. Empty = that ad type is off.
    rewardedPlacementId: "xMR5Q-PDZR-A9W2-B4E8",
    interstitialPlacementId: "xNUHV-K2WG-YCFW-VGMX",
    // Game server base URL, no trailing slash (e.g. "https://rewards.example.com"): Tools/reward-server, for rewards
    // AND purchases. It issues rewarded-ad requestIds and receives ONE store's postback (SSV); its
    // /onestore/reward-ad/webhook is the callback URL registered in 수익화 > 인앱 광고. It also verifies and
    // acknowledges remove-ads purchases (/v1/purchases/*). Empty = rewarded ads off (ONE store grants only after SSV)
    // and remove-ads not sold. Remove-ads is sold only with this server AND interstitialPlacementId set, and only while
    // the server reports "purchases": true at /v1/health (its ONE store IAP secrets are set; README step 7).
    rewardServer: "https://neoncat-rewards.lemoncube.workers.dev",
    // Game product id -> ONEconsole in-app product id (수익화 > 인앱 상품, managed product; the server's IAP_PRODUCTS).
    // Remove-ads is sold only once listed here: add  removingads: "removingads"  after the managed product is registered
    // in ONEconsole (registration needs approved settlement info). Until then the button stays hidden.
    products: {},
  },
}, window.NeonCatConfig || {});
