// CLEAR: background service worker.
// Installs default settings, owns the right-click menu, runs Explain & Simplify,
// and makes still frames for cross-origin GIFs.
importScripts("defaults.js", "models.js", "clarify.js");

async function getPrefs() {
  const stored = await chrome.storage.local.get(["clear_prefs"]);
  return clearNormalizePrefs(stored.clear_prefs);
}

// A small "off" on the toolbar icon while the master switch is off.
function showOnOff(prefs) {
  chrome.action.setBadgeBackgroundColor({ color: "#6b7a75" });
  chrome.action.setBadgeText({ text: prefs.enabled ? "" : "off" });
  chrome.action.setTitle({ title: prefs.enabled ? "CLEAR" : "CLEAR is turned off" });
}

// --- Right-click menu ------------------------------------------------------
async function setupMenus() {
  const prefs = clearEffectivePrefs(await getPrefs());
  showOnOff(prefs);
  await chrome.contextMenus.removeAll();
  if (!prefs.enable_clarify) return;
  chrome.contextMenus.create({ id: "clear-explain", title: "CLEAR: Explain this", contexts: ["selection"] });
  chrome.contextMenus.create({ id: "clear-simplify", title: "CLEAR: Simplify this", contexts: ["selection"] });
}

chrome.runtime.onInstalled.addListener(async () => {
  // Writes defaults on first install and upgrades settings saved by older versions.
  await chrome.storage.local.set({ clear_prefs: await getPrefs() });
  await setupMenus();
  clearModelCheck(); // picks up models already in the cache, so nothing downloads twice
});
chrome.runtime.onStartup.addListener(() => { setupMenus(); clearModelCheck(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.clear_prefs) return;
  const before = clearEffectivePrefs(clearNormalizePrefs(changes.clear_prefs.oldValue));
  const after = clearEffectivePrefs(clearNormalizePrefs(changes.clear_prefs.newValue));
  if (before.enable_clarify !== after.enable_clarify || before.enabled !== after.enabled) setupMenus();
});

// Showing the result has three levels, so a right-click never ends in nothing:
// 1. the card inside the page;
// 2. if the page has no working copy of CLEAR (the tab was open before CLEAR
//    was installed or reloaded), put a fresh copy in and try again;
// 3. if the page cannot be reached at all, a small window of CLEAR's own.
async function showInPage(tabId, message, frameId) {
  const options = typeof frameId === "number" ? { frameId } : undefined;
  try {
    const r = await chrome.tabs.sendMessage(tabId, message, options);
    return !!(r && r.ok);
  } catch (e) {
    return false;
  }
}

async function injectFresh(tabId, frameId) {
  const target = typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId };
  try {
    await chrome.scripting.insertCSS({ target, files: ["styles.css"] });
    await chrome.scripting.executeScript({ target, files: ["defaults.js", "content.js"] });
    return true;
  } catch (e) {
    return false;
  }
}

function openResultWindow(mode, text) {
  const url = chrome.runtime.getURL("result.html") + "?mode=" + mode + "#" + encodeURIComponent(String(text).slice(0, 6000));
  chrome.windows.create({ url, type: "popup", width: 440, height: 560 }).catch(() => {});
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const mode = info.menuItemId === "clear-explain" ? "explain" : info.menuItemId === "clear-simplify" ? "simplify" : null;
  if (!mode || !info.selectionText) return;
  const message = { type: "clarify-open", mode, text: info.selectionText };
  if (tab && tab.id !== undefined && tab.id >= 0) {
    if (await showInPage(tab.id, message, info.frameId)) return;
    if (await injectFresh(tab.id, info.frameId)) {
      await new Promise((r) => setTimeout(r, 250)); // let the new copy load its settings
      if (await showInPage(tab.id, message, info.frameId)) return;
    }
  }
  openResultWindow(mode, info.selectionText);
});

// --- Messages from content scripts ----------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "clarify") {
    clearClarify(msg.mode, msg.text)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: "Something went wrong. Please try again." }));
    return true; // async response
  }

  // First frame of an animated GIF, for images the page itself cannot read
  // (cross-origin images would taint a canvas in the content script).
  if (msg?.type === "gif-still") {
    (async () => {
      try {
        if (!/^https?:/i.test(msg.url)) throw new Error("unsupported url");
        const res = await fetch(msg.url, { credentials: "omit" });
        const blob = await res.blob();
        // "sniff": the address does not say what the picture is (no .gif ending,
        // or a .webp), so look at the file itself and only answer for moving ones.
        if (msg.sniff) {
          if (blob.size > 25000000 || !clearIsAnimated(new Uint8Array(await blob.arrayBuffer()))) {
            sendResponse({ ok: false, animated: false });
            return;
          }
        }
        const bmp = await createImageBitmap(blob);
        if (bmp.width * bmp.height > 6000000) throw new Error("too large");
        const canvas = new OffscreenCanvas(bmp.width || 64, bmp.height || 64);
        canvas.getContext("2d").drawImage(bmp, 0, 0);
        const out = await canvas.convertToBlob({ type: "image/png" });
        const reader = new FileReader();
        reader.onload = () => sendResponse({ ok: true, still: reader.result });
        reader.onerror = () => sendResponse({ ok: false });
        reader.readAsDataURL(out);
      } catch (e) {
        sendResponse({ ok: false });
      }
    })();
    return true; // async response
  }
});

// Is this file a moving picture? Animated GIF, animated WebP or animated PNG.
function clearIsAnimated(b) {
  const tag = (i, t) => { for (let k = 0; k < t.length; k++) if (b[i + k] !== t.charCodeAt(k)) return false; return true; };
  if (b.length < 16) return false;
  if (tag(0, "GIF8")) {
    // Count picture blocks; two or more means it moves.
    let p = 13, frames = 0;
    if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
    const skipBlocks = () => { while (p < b.length && b[p] !== 0) p += b[p] + 1; p++; };
    while (p < b.length) {
      const t = b[p++];
      if (t === 0x2c) {
        if (++frames > 1) return true;
        const flags = b[p + 8]; p += 9;
        if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
        p++; skipBlocks();
      } else if (t === 0x21) { p++; skipBlocks(); }
      else break;
    }
    return false;
  }
  if (tag(0, "RIFF") && tag(8, "WEBP")) return tag(12, "VP8X") && (b[20] & 0x02) !== 0;
  if (b[0] === 0x89 && tag(1, "PNG")) {
    // An "acTL" chunk before the picture data marks an animated PNG.
    let p = 8;
    while (p + 8 < b.length && p < 4096) {
      const len = (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
      if (tag(p + 4, "acTL")) return true;
      if (tag(p + 4, "IDAT")) return false;
      p += 12 + len;
    }
  }
  return false;
}
