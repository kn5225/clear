// CLEAR: shared defaults. Loaded by the content script, the popup and the
// background service worker so all three always agree on the settings shape.
(function (g) {
  const DEFAULTS = {
    enabled: true,              // master switch: off means CLEAR changes nothing on any page
    freeze_autoplay: true,      // pause media that starts playing by itself
    reduce_animations: true,    // stop CSS/JS animations and freeze GIFs
    soften_colors: true,        // slightly dim images and video
    sensory_level: "subtle",    // strength of the dimming: subtle | moderate | strong
    desaturate_amount: 0,       // 0-100, whole-page color reduction
    blur_media: false,          // blur pictures and video until the pointer is over them
    show_page_forecast: true,   // the "This page" panel
    enable_clarify: true,       // Explain / Simplify for selected text
  };

  function normalize(stored) {
    const s = stored && typeof stored === "object" ? stored : {};
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof s[k] === typeof DEFAULTS[k]) out[k] = s[k];
    }
    // Setting from version 1.0 ("Decode messages") carries over.
    if (typeof s.enable_clarify !== "boolean" && typeof s.enable_text_decoding === "boolean") {
      out.enable_clarify = s.enable_text_decoding;
    }
    if (!["subtle", "moderate", "strong"].includes(out.sensory_level)) out.sensory_level = "subtle";
    out.desaturate_amount = Math.min(100, Math.max(0, Math.round(+out.desaturate_amount || 0)));
    return out;
  }

  // What the settings amount to once the master switch is taken into account.
  // The saved settings are left alone, so turning CLEAR back on restores them.
  function effective(prefs) {
    if (prefs.enabled) return prefs;
    return {
      ...prefs,
      freeze_autoplay: false, reduce_animations: false, soften_colors: false, desaturate_amount: 0,
      blur_media: false, show_page_forecast: false, enable_clarify: false,
    };
  }

  g.CLEAR_DEFAULTS = DEFAULTS;
  g.clearEffectivePrefs = effective;
  g.clearNormalizePrefs = normalize;
})(globalThis);
