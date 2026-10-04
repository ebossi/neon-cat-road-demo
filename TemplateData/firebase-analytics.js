// Firebase Web Analytics bridge for the Unity HTML5 player. No native Firebase SDK is used here.
// The public Firebase app configuration belongs in platform-config.js; never add server credentials.
(function () {
  "use strict";

  const EVENT_NAMES = new Set([
    "level_start", "level_end", "level_suspend", "level_resume", "item_used",
    "ad_requested", "ad_unavailable", "ad_init_failed", "ad_load_failed", "ad_show_failed",
    "ad_impression", "ad_closed", "ad_reward_pending", "ad_reward_granted",
    "web_analytics_check", "web_game_ready", "hint_view", "hint_replay"
  ]);
  const PARAM_NAMES = new Set([
    "build_type", "level_name", "pack", "stage", "attempt_id", "moves", "duration_seconds",
    "attempt_number", "first_attempt", "items_used", "reason", "success", "stars",
    "stage_context", "item_name", "ad_platform", "ad_format", "ad_source", "ad_unit_name",
    "value", "currency", "deferred", "hint_type", "hint_count", "test_id", "load_ms"
  ]);

  async function loadSdk() {
    const [app, analytics] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/12.19.0/firebase-analytics.js")
    ]);
    return { ...app, ...analytics };
  }

  function start(win, config, options = {}) {
    const host = win.NeonCatHost = win.NeonCatHost || {};
    if (host.analyticsStatus) return host.analyticsStatus;
    const query = new URLSearchParams(win.location.search);
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(win.location.hostname);
    const debug = query.get("analytics_debug") === "1" || local || query.has("mockads") || query.has("mockiap");
    const status = host.analyticsStatus = {
      state: "loading", debug, measurementId: config && config.firebase && config.firebase.measurementId || "",
      submitted: 0, queued: 0, dropped: 0, lastEvent: "", googleTag: "pending",
      testId: "web-" + Date.now().toString(36),
      // 'submitted' means handed to the SDK, not confirmed in the Firebase console.
    };
    const queue = [];
    let sdk, analytics;
    let timeout;
    const terminal = () => ["disabled", "unsupported", "failed", "timeout"].includes(status.state);
    function stop(state) {
      status.state = state;
      status.dropped += queue.length;
      queue.length = 0;
      status.queued = 0;
    }
    function submit(event) {
      try {
        sdk.logEvent(analytics, event.name, event.values);
        status.submitted++;
        status.lastEvent = event.name;
        return true;
      } catch (_) {
        status.dropped++;
        return false;
      }
    }
    host.analytics = function (json) {
      try {
        if (terminal()) return false;
        const event = typeof json === "string" ? JSON.parse(json) : json;
        if (!event || !EVENT_NAMES.has(event.name)) return false;
        if (event.name === "web_analytics_check" && !debug) return false;
        // Development builds only emit to Firebase when explicitly testing (or on localhost).
        if (event.values && event.values.build_type === "development" && !debug) return false;
        const values = {};
        for (const [key, value] of Object.entries(event.values || {})) {
          if (!PARAM_NAMES.has(key)) continue;
          if (typeof value === "number" && Number.isFinite(value)) values[key] = value;
          else if (typeof value === "string") values[key] = value.slice(0, 100);
          else if (typeof value === "boolean") values[key] = value ? 1 : 0;
        }
        // Do not send ONE store player IDs, purchase tokens, full URLs, or arbitrary payload fields.
        values.game_platform = host.platform || (query.get("platform") === "onestore" ? "onestore" : "web");
        values.onestore_sdk_ready = host.platform === "onestore" ? 1 : 0;
        values.test_traffic = debug ? 1 : 0;
        if (debug) values.debug_mode = true;
        const clean = { name: event.name, values };
        if (status.state === "ready") return submit(clean);
        if (queue.length >= 64) { status.dropped++; return false; }
        queue.push(clean);
        status.queued = queue.length;
        return true;
      } catch (_) { return false; }
    };

    if (!config || config.enabled !== true || query.get("analytics") === "0") {
      stop("disabled");
      status.ready = Promise.resolve(status);
      return status;
    }
    const firebase = config.firebase || {};
    if (!firebase.apiKey || !firebase.appId || !firebase.projectId || !/^G-[A-Z0-9]+$/.test(firebase.measurementId || "")) {
      stop("failed");
      status.ready = Promise.resolve(status);
      return status;
    }

    status.ready = (async function () {
      try {
        const loaded = await Promise.race([
          (options.loadSdk || loadSdk)().then(async value => ({ sdk: value, supported: await value.isSupported() })),
          new Promise(resolve => { timeout = setTimeout(() => resolve(null), options.timeoutMs || 10000); })
        ]);
        clearTimeout(timeout);
        if (!loaded) { stop("timeout"); return status; }
        if (!loaded.supported) { stop("unsupported"); return status; }
        sdk = loaded.sdk;
        const app = sdk.initializeApp(firebase, "neoncat-web-analytics");
        const settings = {
          send_page_view: false,
          page_location: win.location.origin + win.location.pathname,
          page_referrer: "",
          allow_google_signals: false,
          allow_ad_personalization_signals: false,
          cookie_flags: "SameSite=None;Secure"
        };
        if (debug) settings.debug_mode = true;
        analytics = sdk.initializeAnalytics(app, { config: settings });
        status.state = "ready";
        if (debug && typeof sdk.getGoogleAnalyticsClientId === "function") {
          const tagTimeout = setTimeout(() => { status.googleTag = "timeout"; }, 15000);
          sdk.getGoogleAnalyticsClientId(analytics).then(() => {
            clearTimeout(tagTimeout);
            status.googleTag = "ready";
          }).catch(() => {
            clearTimeout(tagTimeout);
            status.googleTag = "failed";
          });
        }
        while (queue.length) submit(queue.shift());
        status.queued = 0;
        if (debug) host.analytics({ name: "web_analytics_check", values: { test_id: status.testId } });
      } catch (_) {
        clearTimeout(timeout);
        stop("failed");
        // Analytics must never prevent the game, ads, or purchases from starting.
      }
      return status;
    })();
    return status;
  }

  if (typeof module === "object" && module.exports) module.exports = { start };
  else start(window, (window.NeonCatConfig || {}).firebaseAnalytics);
})();
