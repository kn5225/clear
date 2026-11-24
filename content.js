// CLEAR: content script.
// Runs in every frame. Stops autoplay and motion, reduces color intensity,
// shows the Page Forecast panel, and offers Explain / Simplify for selected text.
(() => {
  // One working copy per frame. A copy left behind by an earlier install or
  // reload of CLEAR can no longer talk to the extension, so it does not count:
  // the new copy takes over and removes what the old one left on the page.
  const runtimeAtLoad = (() => { try { return chrome.runtime; } catch (e) { return null; } })();
  const stillConnected = () => { try { return !!(runtimeAtLoad && runtimeAtLoad.id); } catch (e) { return false; } };
  const earlier = globalThis.__clearContentLoaded;
  if (earlier && typeof globalThis.__clearContentAlive === "function" && globalThis.__clearContentAlive()) return;
  globalThis.__clearContentLoaded = true;
  globalThis.__clearContentAlive = stillConnected;
  if (earlier) {
    for (const id of ["clear-panel-host", "clear-clarify-host"]) {
      try { document.querySelectorAll("#" + id).forEach((el) => el.remove()); } catch (e) {}
    }
  }

  const IS_TOP = (() => { try { return window.top === window; } catch (e) { return false; } })();
  const normalize = globalThis.clearNormalizePrefs;
  let prefs = normalize(null);
  let prefsLoaded = false;

  // Counters for the "What CLEAR changed" list.
  const stats = { media: 0, gifs: 0, anims: 0 };

  const extensionAlive = stillConnected;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  // --- Settings --------------------------------------------------------------
  let localDesatAt = 0; // when the on-page slider was last moved

  async function loadPrefs() {
    try {
      const stored = await chrome.storage.local.get(["clear_prefs"]);
      prefs = globalThis.clearEffectivePrefs(normalize(stored.clear_prefs));
    } catch (e) { /* storage unavailable: keep defaults */ }
    prefsLoaded = true;
    applyAll();
  }

  let saveTimer = null;
  function savePrefsSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!extensionAlive() || !prefs.enabled) return; // never save the switched-off view of the settings
      chrome.storage.local.set({ clear_prefs: prefs }).catch(() => {});
    }, 80);
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.clear_prefs) return;
      const next = normalize(changes.clear_prefs.newValue);
      // While the on-page slider is being dragged, its own value wins over the
      // slightly older value echoed back from storage.
      if (Date.now() - localDesatAt < 500) next.desaturate_amount = prefs.desaturate_amount;
      prefs = globalThis.clearEffectivePrefs(next);
      applyAll();
    });
  } catch (e) {}

  // --- Color -----------------------------------------------------------------
  const DIM_BY_LEVEL = {
    subtle: "brightness(0.98) saturate(0.92)",
    moderate: "brightness(0.94) saturate(0.82)",
    strong: "brightness(0.88) saturate(0.68)",
  };

  function applyColor() {
    const root = document.documentElement;
    if (!root) return;

    // Whole-page color reduction. Only the top frame gets the filter: it already
    // covers every embedded frame, and filtering both would apply it twice.
    const amount = IS_TOP ? clamp(prefs.desaturate_amount, 0, 100) : 0;
    if (amount > 0) {
      root.style.setProperty("--clear-sat", String(1 - amount / 100), "important");
      root.classList.add("clear-desat");
    } else {
      root.classList.remove("clear-desat");
      root.style.removeProperty("--clear-sat");
    }

    if (prefs.soften_colors) {
      root.style.setProperty("--clear-filter", DIM_BY_LEVEL[prefs.sensory_level] || DIM_BY_LEVEL.subtle);
      root.classList.add("clear-softened");
    } else {
      root.classList.remove("clear-softened");
      root.style.removeProperty("--clear-filter");
    }
  }

  // --- Autoplay --------------------------------------------------------------
  // A video or audio element may play only if the person started it. Anything
  // that starts by itself is paused, whenever it starts (not only at page load).
  const allowed = new WeakSet();  // media the person chose to play
  const counted = new WeakSet();  // media already counted in stats
  let gesture = { at: 0, x: 0, y: 0, href: "", key: false };

  addEventListener("pointerdown", (e) => {
    if (e.isTrusted) gesture = { at: performance.now(), x: e.clientX, y: e.clientY, href: location.href, key: false };
  }, true);
  addEventListener("click", (e) => {
    if (e.isTrusted) gesture = { at: performance.now(), x: e.clientX, y: e.clientY, href: location.href, key: e.detail === 0 };
  }, true);
  addEventListener("keydown", (e) => {
    if (e.isTrusted && [" ", "Enter", "k", "K", "MediaPlayPause", "MediaPlay"].includes(e.key)) {
      gesture = { at: performance.now(), x: -1, y: -1, href: location.href, key: true };
    }
  }, true);

  function startedByPerson(media) {
    const age = performance.now() - gesture.at;
    if (!gesture.key && age < 5000) {
      // A click on the player itself. Players often load before they start, so allow a longer wait.
      const r = media.getBoundingClientRect();
      if (gesture.x >= r.left && gesture.x <= r.right && gesture.y >= r.top && gesture.y <= r.bottom + 60) return true;
    }
    // A click elsewhere counts (for example a separate play button), unless it
    // navigated to another page: the next page's video then starts by itself.
    return age < 1500 && gesture.href === location.href;
  }

  function pauseMedia(media) {
    try {
      media.autoplay = false;
      if (!media.paused) media.pause();
      media.setAttribute("data-clear-paused", "true");
      if (!counted.has(media)) { counted.add(media); stats.media++; schedulePanel(); }
    } catch (e) {}
  }

  function onPlay(e) {
    const media = e.target;
    if (!(media instanceof HTMLMediaElement)) return;
    if (!prefsLoaded || !prefs.freeze_autoplay) return;
    if (allowed.has(media)) return;
    if (startedByPerson(media)) {
      allowed.add(media);
      media.removeAttribute("data-clear-paused");
      return;
    }
    pauseMedia(media);
  }
  // Media events do not bubble, but they can be captured at the document.
  document.addEventListener("play", onPlay, true);
  document.addEventListener("playing", onPlay, true);
  // A new source in the same player (next episode, next clip) is a new start.
  document.addEventListener("emptied", (e) => { if (e.target instanceof HTMLMediaElement) allowed.delete(e.target); }, true);

  function scanMedia() {
    if (!prefsLoaded) return;
    if (!prefs.freeze_autoplay) { releaseMedia(); return; }
    document.querySelectorAll("video, audio").forEach((media) => {
      if (allowed.has(media)) return;
      if (!media.paused || media.autoplay) pauseMedia(media);
    });
  }

  function playMedia(media) {
    allowed.add(media);
    media.removeAttribute("data-clear-paused");
    try { const p = media.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }

  function releaseMedia() {
    document.querySelectorAll("[data-clear-paused]").forEach((media) => {
      if (media instanceof HTMLMediaElement) playMedia(media);
    });
  }

  // --- GIFs ------------------------------------------------------------------
  const isGifUrl = (u) => /^data:image\/gif/i.test(u) || /\.gif(?:[?#]|$)/i.test(u) || /(?:giphy|tenor)\.com\/.*gif/i.test(u);

  // Pictures whose address does not say what they are. Many sites serve moving
  // pictures as .webp, or from addresses with no ending at all, so these are
  // checked by looking at the file itself (in the background worker).
  const STATIC_URL = /\.(?:jpe?g|png|svg|avif|ico|bmp)(?:[?#]|$)|[?&](?:format|fm|f)=(?:jpe?g|png|pjpg)/i;
  const notMoving = new Set();   // addresses already checked and found to be still pictures
  const stills = new WeakMap();  // img -> the still frame CLEAR put in it
  const sourceSets = new WeakMap(); // <source> -> its original srcset
  let sniffBudget = 80;          // file checks per page

  function setStill(img, still) {
    if (!img.isConnected || img.dataset.clearFrozen !== "pending") return;
    if (img.hasAttribute("srcset")) { img.dataset.clearOrigSrcset = img.getAttribute("srcset"); img.removeAttribute("srcset"); }
    // Inside <picture>, the <source> elements win over the image's own address.
    const pic = img.parentElement && img.parentElement.tagName === "PICTURE" ? img.parentElement : null;
    if (pic) pic.querySelectorAll("source").forEach((so) => { sourceSets.set(so, so.getAttribute("srcset")); so.setAttribute("srcset", still); });
    stills.set(img, still);
    img.src = still;
    img.dataset.clearFrozen = "1";
    stats.gifs++;
    schedulePanel();
  }

  function freezeGif(img) {
    const url = img.currentSrc || img.src || "";
    if (!url || img.dataset.clearPlayed) return;
    if (img.dataset.clearFrozen) return;
    const named = isGifUrl(url);
    const unknown = !named && /^https?:/i.test(url) && !STATIC_URL.test(url) && !notMoving.has(url);
    if (!named && !unknown) return;
    // Wait until the picture has loaded, otherwise the still frame is blank.
    if (!img.complete || !img.naturalWidth) {
      img.addEventListener("load", () => freezeGif(img), { once: true });
      return;
    }
    // One-pixel placeholders (lazy loading) are not worth freezing, and freezing
    // them used to stop the real picture from being looked at when it arrived.
    if (img.naturalWidth <= 2 || img.naturalHeight <= 2) return;

    if (unknown) {
      if (img.clientWidth < 48 || img.clientHeight < 48 || sniffBudget <= 0 || !extensionAlive()) return;
      sniffBudget--;
      img.dataset.clearFrozen = "pending";
      img.dataset.clearOrigSrc = url;
      chrome.runtime.sendMessage({ type: "gif-still", url, sniff: true }, (r) => {
        void chrome.runtime.lastError;
        if (r && r.ok && r.still) setStill(img, r.still);
        else { if (r && r.animated === false) notMoving.add(url); unfreezeGif(img, false); }
      });
      return;
    }

    img.dataset.clearFrozen = "pending";
    img.dataset.clearOrigSrc = url;
    try {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      setStill(img, c.toDataURL("image/png"));
      return;
    } catch (e) { /* cross-origin image: ask the background worker for a still */ }
    if (!extensionAlive() || !/^https?:/i.test(url)) { unfreezeGif(img, false); return; }
    chrome.runtime.sendMessage({ type: "gif-still", url }, (r) => {
      void chrome.runtime.lastError;
      if (r && r.ok && r.still) setStill(img, r.still);
      else unfreezeGif(img, false);
    });
  }

  function restoreSources(img) {
    const pic = img.parentElement && img.parentElement.tagName === "PICTURE" ? img.parentElement : null;
    if (!pic) return;
    pic.querySelectorAll("source").forEach((so) => {
      if (!sourceSets.has(so)) return;
      const v = sourceSets.get(so);
      if (v === null) so.removeAttribute("srcset"); else so.setAttribute("srcset", v);
      sourceSets.delete(so);
    });
  }

  function unfreezeGif(img, byPerson) {
    const wasFrozen = img.dataset.clearFrozen === "1";
    if (wasFrozen) restoreSources(img);
    if (wasFrozen && img.dataset.clearOrigSrc) img.src = img.dataset.clearOrigSrc;
    if (img.dataset.clearOrigSrcset) img.setAttribute("srcset", img.dataset.clearOrigSrcset);
    delete img.dataset.clearFrozen; delete img.dataset.clearOrigSrc; delete img.dataset.clearOrigSrcset;
    stills.delete(img);
    if (byPerson) img.dataset.clearPlayed = "1";
  }

  function scanGifs() {
    if (!prefsLoaded) return;
    if (!prefs.reduce_animations) {
      document.querySelectorAll("img[data-clear-frozen]").forEach((img) => unfreezeGif(img, false));
      return;
    }
    document.querySelectorAll("img").forEach((img) => {
      // The page put a different picture in a frozen image (lazy loaders and
      // slideshows do this). Forget the old still and look at the new picture.
      if (img.dataset.clearFrozen === "1" && stills.get(img) !== img.getAttribute("src")) {
        delete img.dataset.clearFrozen; delete img.dataset.clearOrigSrc; delete img.dataset.clearOrigSrcset;
        stills.delete(img);
      }
      freezeGif(img);
    });
  }

  // --- Blur ------------------------------------------------------------------
  // Pictures and video are blurred until the pointer (or keyboard focus) is on
  // them. Small pictures such as icons, logos and avatars are left sharp so
  // pages stay usable.
  function scanBlur() {
    if (!prefsLoaded) return;
    const root = document.documentElement;
    if (!prefs.blur_media) {
      if (root.classList.contains("clear-blur")) {
        root.classList.remove("clear-blur");
        document.querySelectorAll("[data-clear-blur]").forEach((el) => el.removeAttribute("data-clear-blur"));
      }
      return;
    }
    root.classList.add("clear-blur");
    document.querySelectorAll("img:not([data-clear-blur]), video:not([data-clear-blur])").forEach((el) => {
      if (el.tagName === "VIDEO" || (el.clientWidth >= 80 && el.clientHeight >= 80)) el.setAttribute("data-clear-blur", "");
      else if (el.tagName === "IMG" && !el.complete) el.addEventListener("load", scanSoon, { once: true });
    });
  }

  // --- Animations ------------------------------------------------------------
  const pausedAnims = new Set();
  function applyAnimations() {
    const root = document.documentElement;
    if (!root || !prefsLoaded) return;
    if (!prefs.reduce_animations) {
      root.classList.remove("clear-reduced-anim");
      pausedAnims.forEach((a) => { try { a.play(); } catch (e) {} });
      pausedAnims.clear();
      document.querySelectorAll("svg").forEach((s) => { try { s.unpauseAnimations && s.unpauseAnimations(); } catch (e) {} });
      document.querySelectorAll("marquee").forEach((m) => { try { m.start(); } catch (e) {} });
      return;
    }
    root.classList.add("clear-reduced-anim");
    try {
      document.getAnimations().forEach((a) => {
        const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
        if (a.playState === "running" && timing.iterations === Infinity && !pausedAnims.has(a)) {
          try { a.pause(); pausedAnims.add(a); stats.anims++; } catch (e) {}
        }
      });
    } catch (e) {}
    document.querySelectorAll("marquee").forEach((m) => { try { m.stop(); } catch (e) {} });
    document.querySelectorAll("svg").forEach((s) => { try { s.pauseAnimations && s.pauseAnimations(); } catch (e) {} });
  }

  // --- "Play" button over paused media ---------------------------------------
  let playBtn = null, playTarget = null, pointerX = -1, pointerY = -1, hoverQueued = false;

  function pausedThingAt(x, y) {
    if (x < 0 || y < 0) return null;
    // elementsFromPoint also finds a video that sits underneath a site's overlay.
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === playBtn) continue;
      if (el instanceof HTMLMediaElement && el.hasAttribute("data-clear-paused")) return el;
      if (el instanceof HTMLImageElement && el.dataset.clearFrozen === "1") return el;
    }
    return null;
  }

  function ensurePlayBtn() {
    if (playBtn) return playBtn;
    playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "clear-play";
    playBtn.textContent = "▶ Play";
    playBtn.style.display = "none";
    playBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const target = playTarget;
      hidePlayBtn();
      if (!target) return;
      if (target instanceof HTMLMediaElement) playMedia(target);
      else unfreezeGif(target, true);
    });
    document.documentElement.append(playBtn);
    return playBtn;
  }
  function hidePlayBtn() { playTarget = null; if (playBtn) playBtn.style.display = "none"; }

  function updatePlayBtn() {
    hoverQueued = false;
    if (!document.documentElement) return;
    // Pointer resting on the button itself: keep the current target.
    if (playBtn && playTarget && document.elementFromPoint(pointerX, pointerY) === playBtn) return;
    const target = document.querySelector("[data-clear-paused], img[data-clear-frozen='1']") ? pausedThingAt(pointerX, pointerY) : null;
    if (!target) { hidePlayBtn(); return; }
    playTarget = target;
    const b = ensurePlayBtn();
    const r = target.getBoundingClientRect();
    b.style.setProperty("left", clamp(r.left + 8, 4, innerWidth - 80) + "px", "important");
    b.style.setProperty("top", clamp(r.top + 8, 4, innerHeight - 36) + "px", "important");
    b.style.display = "";
  }
  addEventListener("pointermove", (e) => {
    pointerX = e.clientX; pointerY = e.clientY;
    if (!hoverQueued) { hoverQueued = true; requestAnimationFrame(updatePlayBtn); }
  }, { passive: true });
  addEventListener("scroll", () => { if (playTarget && !hoverQueued) { hoverQueued = true; requestAnimationFrame(updatePlayBtn); } }, { passive: true, capture: true });

  function resumeEverything() {
    document.querySelectorAll("[data-clear-paused]").forEach((m) => { if (m instanceof HTMLMediaElement) playMedia(m); });
    document.querySelectorAll("img[data-clear-frozen]").forEach((img) => unfreezeGif(img, true));
    hidePlayBtn();
  }

  // --- Page Forecast panel (top frame only, shadow DOM) -----------------------
  const AD_SELECTOR = [
    "ins.adsbygoogle", "[id^='ad-' i]", "[id^='ads-' i]", "[id^='ad_' i]", "[id*='google_ads' i]",
    "[class~='ad' i]", "[class~='ads' i]", "[class~='advert' i]", "[class*='advertisement' i]", "[class*='sponsored' i]",
    "iframe[src*='doubleclick']", "iframe[src*='googlesyndication']",
  ].join(",");

  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

  function buildForecast() {
    const videos = document.querySelectorAll("video").length;
    const gifs = [...document.images].filter((i) => i.dataset.clearFrozen || isGifUrl(i.currentSrc || i.src || "")).length;
    let looping = stats.anims;
    if (!prefs.reduce_animations) {
      try {
        looping = document.getAnimations().filter((a) => a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity).length;
      } catch (e) {}
    }
    const moving = gifs + looping + document.querySelectorAll("marquee").length;
    const images = document.images.length;
    let ads = 0;
    try { ads = [...document.querySelectorAll(AD_SELECTOR)].filter((el) => !el.parentElement || !el.parentElement.closest(AD_SELECTOR)).length; } catch (e) {}
    const words = ((document.body && document.body.innerText) || "").trim().split(/\s+/).filter(Boolean).length;
    const readMin = Math.max(1, Math.round(words / 220));
    const screens = Math.max(1, Math.round(((document.body && document.body.scrollHeight) || innerHeight) / innerHeight));
    const score = videos * 2 + moving + ads * 1.5;
    const level = score > 40 ? "Very busy page" : score > 22 ? "Busy page" : "Calm page";

    const items = [];
    if (videos) items.push(plural(videos, "video"));
    if (moving) items.push(plural(moving, "moving image or animation", "moving images or animations"));
    if (images) items.push(plural(images, "image"));
    if (ads) items.push(plural(ads, "ad"));
    items.push(plural(readMin, "minute") + " to read");
    items.push(plural(screens, "screen") + " long");

    const did = [];
    if (stats.media) did.push("Stopped " + plural(stats.media, "video or sound", "videos or sounds") + " from playing by itself");
    if (stats.gifs) did.push("Paused " + plural(stats.gifs, "GIF"));
    if (stats.anims) did.push("Stopped " + plural(stats.anims, "looping animation"));
    if (prefs.desaturate_amount > 0) did.push("Reduced color by " + prefs.desaturate_amount + "%");
    const canResume = !!document.querySelector("[data-clear-paused], img[data-clear-frozen='1']");
    return { level, items, did, canResume };
  }

  const PANEL_CSS = `
    :host { all: initial; }
    .panel {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
      box-sizing: border-box; width: 300px; max-width: calc(100vw - 32px); max-height: 70vh; overflow: auto;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #ecebe6; background: #2f3333; border: 1px solid #4a4f51; border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.35); padding: 14px 14px 12px;
    }
    .head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 8px; }
    h2 { font-size: 13px; font-weight: 700; letter-spacing: .04em; margin: 0; color: #fff; }
    .level { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #d4d2ca; margin-top: 3px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: #6fae8a; }
    .dot.busy { background: #e08a3d; } .dot.mid { background: #d9b53d; }
    button { font: inherit; cursor: pointer; }
    .x { border: none; background: transparent; color: #c2c0b7; font-size: 18px; line-height: 1; border-radius: 6px; padding: 2px 6px; }
    .x:hover { color: #fff; background: #4a4f51; }
    button:focus-visible, input:focus-visible { outline: 2px solid #9fd0d4; outline-offset: 2px; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { padding: 3px 0; color: #dddbd3; }
    .did-wrap { margin-top: 10px; }
    h3 { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #9fd0d4; margin: 0 0 4px; }
    .resume { margin-top: 6px; border: 1px solid #5c6264; background: transparent; color: #ecebe6; border-radius: 999px; padding: 4px 12px; font-size: 12px; }
    .resume:hover { background: #4a4f51; }
    .color { margin-top: 12px; padding-top: 10px; border-top: 1px solid #4a4f51; }
    .color-head { display: flex; justify-content: space-between; align-items: baseline; }
    .color-head label { font-size: 13px; color: #ecebe6; }
    .amt { font-size: 12px; color: #d4d2ca; }
    .slider { width: 100%; margin: 8px 0 2px; accent-color: #6fae8a; }
    .swatches { display: flex; gap: 6px; margin: 6px 0 4px; }
    .swatch { width: 20px; height: 20px; border-radius: 50%; display: inline-block; }
    .help { font-size: 11px; color: #b3b1a8; }
    [hidden] { display: none !important; }
  `;

  let panelHost = null, panel = null, panelDismissed = false, panelTimer = null;

  function ensurePanel() {
    if (panel) return panel;
    panelHost = document.createElement("div");
    panelHost.id = "clear-panel-host";
    const shadow = panelHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    const box = document.createElement("section");
    box.className = "panel";
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "CLEAR page forecast");
    box.innerHTML = `
      <div class="head">
        <div><h2>THIS PAGE</h2><div class="level"><span class="dot"></span><span class="lvl-text"></span></div></div>
        <button class="x" type="button" aria-label="Hide page forecast">×</button>
      </div>
      <ul class="items"></ul>
      <div class="did-wrap" hidden><h3>What CLEAR changed</h3><ul class="did"></ul>
        <button class="resume" type="button" hidden>Play everything again</button></div>
      <div class="color">
        <div class="color-head"><label for="clear-sat">Reduce color</label><span class="amt">0%</span></div>
        <input id="clear-sat" type="range" min="0" max="100" step="1" value="0" class="slider" />
        <div class="swatches" aria-hidden="true"></div>
        <div class="help">Left is full color. Far right is black and white.</div>
      </div>`;
    shadow.append(style, box);
    const $ = (sel) => shadow.querySelector(sel);
    ["#e84d4d", "#e8a23d", "#e8e23d", "#4de87a", "#4d8ae8", "#a04de8"].forEach((c) => {
      const d = document.createElement("span"); d.className = "swatch"; d.style.background = c; $(".swatches").append(d);
    });
    $(".x").addEventListener("click", () => { panelDismissed = true; panelHost.style.display = "none"; });
    $(".resume").addEventListener("click", () => { resumeEverything(); renderPanel(); });
    $(".slider").addEventListener("input", (e) => {
      // Apply to the page straight away, then save in the background.
      prefs.desaturate_amount = +e.target.value;
      localDesatAt = Date.now();
      $(".amt").textContent = prefs.desaturate_amount + "%";
      applyColor();
      savePrefsSoon();
    });
    document.documentElement.append(panelHost);
    panel = { $, slider: $(".slider") };
    return panel;
  }

  function renderPanel() {
    if (!IS_TOP || !prefsLoaded || !document.body) return;
    if (!prefs.show_page_forecast || panelDismissed) { if (panelHost) panelHost.style.display = "none"; return; }
    const { $, slider } = ensurePanel();
    panelHost.style.display = "";
    const f = buildForecast();
    $(".lvl-text").textContent = f.level;
    $(".dot").className = "dot " + (f.level.startsWith("Very") ? "busy" : f.level.startsWith("Busy") ? "mid" : "");
    const fill = (ul, lines) => { ul.textContent = ""; lines.forEach((s) => { const li = document.createElement("li"); li.textContent = s; ul.append(li); }); };
    fill($(".items"), f.items);
    fill($(".did"), f.did);
    $(".did-wrap").hidden = !f.did.length;
    $(".resume").hidden = !f.canResume;
    if (Date.now() - localDesatAt > 500) slider.value = prefs.desaturate_amount;
    $(".amt").textContent = prefs.desaturate_amount + "%";
  }
  function schedulePanel() {
    if (!IS_TOP || panelTimer) return;
    panelTimer = setTimeout(() => { panelTimer = null; renderPanel(); }, 400);
  }

  // --- Explain & Simplify ----------------------------------------------------
  const CLARIFY_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .chip, .card {
      position: fixed; z-index: 2147483647;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #ecebe6; background: #2f3333; border: 1px solid #4a4f51;
      box-shadow: 0 8px 28px rgba(0,0,0,0.35);
    }
    .chip { display: flex; gap: 2px; padding: 3px; border-radius: 999px; }
    button { font: inherit; cursor: pointer; color: inherit; background: transparent; border: none; border-radius: 999px; padding: 4px 11px; }
    button:hover { background: #4a4f51; }
    button:focus-visible { outline: 2px solid #9fd0d4; outline-offset: 1px; }
    .card { width: 380px; max-width: calc(100vw - 16px); max-height: min(70vh, 520px); display: flex; flex-direction: column; border-radius: 14px; }
    .card:focus { outline: none; }
    .top { display: flex; align-items: center; justify-content: space-between; padding: 10px 10px 6px 14px; }
    .title { font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #9fd0d4; }
    .close { font-size: 18px; line-height: 1; padding: 2px 8px; color: #c2c0b7; }
    .body { padding: 2px 14px 10px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.6; color: #f3f2ee; }
    .body.busy { color: #c2c0b7; }
    .note { padding: 0 14px 8px; font-size: 11px; color: #b3b1a8; }
    .actions { display: flex; gap: 6px; padding: 8px 10px 10px; border-top: 1px solid #4a4f51; }
    .actions button { border: 1px solid #5c6264; font-size: 12px; }
    [hidden] { display: none !important; }
  `;
  const MODE_TITLE = { explain: "Explained", simplify: "Simplified" };

  let clarifyHost = null, clarify = null, clarifyToken = 0, lastSelection = null, cardState = null;

  function ensureClarify() {
    if (clarify) return clarify;
    clarifyHost = document.createElement("div");
    clarifyHost.id = "clear-clarify-host";
    const shadow = clarifyHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CLARIFY_CSS;
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="chip" role="group" aria-label="CLEAR text help" hidden>
        <button type="button" data-mode="explain">Explain</button>
        <button type="button" data-mode="simplify">Simplify</button>
      </div>
      <section class="card" role="dialog" aria-label="CLEAR text help" tabindex="-1" hidden>
        <div class="top"><span class="title"></span><button type="button" class="close" aria-label="Close">×</button></div>
        <div class="body" aria-live="polite"></div>
        <div class="note" hidden></div>
        <div class="actions">
          <button type="button" class="switch"></button>
          <button type="button" class="copy">Copy</button>
        </div>
      </section>`;
    shadow.append(style, wrap);
    const $ = (sel) => shadow.querySelector(sel);
    const chip = $(".chip"), card = $(".card");
    // Keep the page selection when the chip is pressed.
    chip.addEventListener("mousedown", (e) => e.preventDefault());
    chip.addEventListener("click", (e) => {
      const mode = e.target && e.target.dataset && e.target.dataset.mode;
      if (mode && lastSelection) openClarify(mode, lastSelection.text, lastSelection.rect);
    });
    $(".close").addEventListener("click", closeCard);
    $(".switch").addEventListener("click", () => {
      if (cardState) openClarify(cardState.mode === "explain" ? "simplify" : "explain", cardState.text, cardState.rect);
    });
    $(".copy").addEventListener("click", async () => {
      const btn = $(".copy");
      try { await navigator.clipboard.writeText($(".body").textContent); btn.textContent = "Copied"; }
      catch (e) { btn.textContent = "Could not copy"; }
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });
    card.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeCard(); } });
    document.documentElement.append(clarifyHost);
    clarify = { $, chip, card, shadow };
    return clarify;
  }

  function place(el, rect, width, height) {
    const gap = 8;
    let left = clamp(rect.left, 8, Math.max(8, innerWidth - width - 8));
    let top = rect.bottom + gap;
    if (top + height > innerHeight - 8) top = rect.top - gap - height;   // above the selection
    if (top < 8) top = clamp(innerHeight - height - 8, 8, innerHeight);  // neither fits: pin to the bottom
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  function readSelection() {
    const active = document.activeElement;
    if (active && (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && /^(text|search|url|email|tel)$/.test(active.type)))) {
      try {
        const text = active.value.slice(active.selectionStart, active.selectionEnd).trim();
        if (text) return { text, rect: active.getBoundingClientRect() };
      } catch (e) {}
    }
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return { text, rect };
  }

  function hideChip() { if (clarify) clarify.chip.hidden = true; }
  function updateChip() {
    if (!prefsLoaded || !prefs.enable_clarify || !extensionAlive()) { hideChip(); return; }
    const sel = readSelection();
    if (!sel || sel.text.length < 2) { hideChip(); return; }
    lastSelection = sel;
    const { chip } = ensureClarify();
    chip.hidden = false;
    place(chip, sel.rect, 170, 34);
  }
  let chipTimer = null;
  const chipSoon = () => { clearTimeout(chipTimer); chipTimer = setTimeout(updateChip, 120); };
  document.addEventListener("mouseup", (e) => { if (e.target !== clarifyHost) chipSoon(); }, true);
  document.addEventListener("keyup", (e) => { if (e.shiftKey || e.key === "Shift" || (e.key === "a" && (e.ctrlKey || e.metaKey))) chipSoon(); }, true);
  document.addEventListener("selectionchange", () => { const s = getSelection(); if (!s || s.isCollapsed) chipSoon(); });
  addEventListener("scroll", hideChip, { passive: true, capture: true });

  function closeCard() {
    clarifyToken++;
    cardState = null;
    if (clarify) clarify.card.hidden = true;
  }

  function tidy(text) {
    // The model sometimes answers with light Markdown; show it as plain text.
    return String(text || "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*[*-]\s+/gm, "• ")
      .trim();
  }

  async function openClarify(mode, text, rect) {
    if (!extensionAlive()) return;
    const { $, card } = ensureClarify();
    hideChip();
    const token = ++clarifyToken;
    rect = rect || { left: innerWidth / 2 - 190, right: innerWidth / 2 + 190, top: innerHeight / 3, bottom: innerHeight / 3 };
    cardState = { mode, text, rect };
    $(".title").textContent = MODE_TITLE[mode];
    $(".switch").textContent = mode === "explain" ? "Simplify instead" : "Explain instead";
    const body = $(".body"), note = $(".note");
    body.className = "body busy";
    body.textContent = "Working on it…";
    note.hidden = true;
    card.hidden = false;
    place(card, rect, Math.min(380, innerWidth - 16), card.offsetHeight);
    card.focus({ preventScroll: true });

    let res;
    try { res = await chrome.runtime.sendMessage({ type: "clarify", mode, text }); }
    catch (e) { res = null; }
    if (token !== clarifyToken) return; // closed or replaced while waiting

    body.className = "body";
    if (!res || !res.ok) {
      body.textContent = (res && res.error) || "CLEAR could not process this text. Reload the page and try again.";
    } else {
      body.textContent = tidy(res.text);
      const notes = [];
      if (res.note) notes.push(res.note);
      else if (res.availability === "downloadable" || res.availability === "downloading") notes.push("Basic mode. Open the CLEAR popup to turn on Chrome's on-device AI, or download CLEAR's own models.");
      else notes.push("Basic mode: no on-device model is installed, so only common phrases and wording are handled. The CLEAR popup can download one.");
      if (res.truncated) notes.push("Only the first part of a long selection was used.");
      note.textContent = notes.join(" ");
      note.hidden = false;
    }
    place(card, rect, Math.min(380, innerWidth - 16), card.offsetHeight);
  }

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== "clarify-open" || !prefs.enable_clarify) return;
      const sel = readSelection();
      openClarify(msg.mode, msg.text, sel ? sel.rect : null);
      sendResponse({ ok: true }); // tells the service worker the card is showing
    });
  } catch (e) {}

  // --- Apply everything ------------------------------------------------------
  function applyAll() {
    if (!document.documentElement) return;
    applyColor();
    if (!prefsLoaded) return;
    applyAnimations();
    scanMedia();
    scanGifs();
    scanBlur();
    if (!prefs.enable_clarify) { hideChip(); closeCard(); }
    renderPanel();
  }

  // New content: check for new media, GIFs and animations (debounced).
  let scanTimer = null;
  function scanSoon() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (!prefsLoaded || !extensionAlive()) return;
      scanMedia(); scanGifs(); scanBlur(); applyAnimations(); schedulePanel();
    }, 250);
  }

  function start() {
    const root = document.documentElement;
    applyAll();
    // New or removed content anywhere on the page.
    new MutationObserver(scanSoon).observe(root, { childList: true, subtree: true });
    // A picture that is swapped in later (lazy loading) arrives as a changed address, not a new element.
    new MutationObserver(scanSoon).observe(root, { subtree: true, attributes: true, attributeFilter: ["src", "srcset"] });
    // Some pages rewrite <html class="...">, which would drop CLEAR's classes.
    new MutationObserver(() => {
      const wantDesat = IS_TOP && prefs.desaturate_amount > 0;
      if ((wantDesat && !root.classList.contains("clear-desat")) ||
          (prefs.soften_colors && !root.classList.contains("clear-softened")) ||
          (prefsLoaded && prefs.reduce_animations && !root.classList.contains("clear-reduced-anim"))) {
        applyColor(); applyAnimations();
      }
    }).observe(root, { attributes: true, attributeFilter: ["class"] });
  }

  if (document.documentElement) start();
  else new MutationObserver((_r, o) => { if (document.documentElement) { o.disconnect(); start(); } }).observe(document, { childList: true });

  document.addEventListener("DOMContentLoaded", applyAll);
  addEventListener("load", () => setTimeout(applyAll, 300));
  loadPrefs();
})();
