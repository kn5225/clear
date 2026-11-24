// CLEAR: popup. Every control saves as soon as it changes; open pages pick the
// new settings up from storage straight away, so there is no Apply button.

const $ = (id) => document.getElementById(id);
const CHECKS = {
  freeze: "freeze_autoplay",
  anim: "reduce_animations",
  soften: "soften_colors",
  forecast: "show_page_forecast",
  clarify: "enable_clarify",
  blur: "blur_media",
  enabled: "enabled",
};
let prefs = clearNormalizePrefs(null);

let statusTimer = null;
function flash(text) {
  $("status").textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $("status").textContent = ""; }, 1200);
}

function save() {
  return chrome.storage.local.set({ clear_prefs: prefs }).then(() => flash("Saved"));
}

// The slider fires many times a second while dragged. Saving at most every
// 60 ms keeps the page following the thumb without flooding storage.
let sliderTimer = null, sliderDirty = false;
function saveSlider() {
  sliderDirty = true;
  if (sliderTimer) return;
  const run = () => {
    sliderTimer = null;
    if (!sliderDirty) return;
    sliderDirty = false;
    save();
    sliderTimer = setTimeout(run, 60);
  };
  run();
}

function render() {
  for (const [id, key] of Object.entries(CHECKS)) $(id).checked = prefs[key];
  $("level").value = prefs.sensory_level;
  $("level").disabled = !prefs.soften_colors;
  $("desat").value = prefs.desaturate_amount;
  $("amt").textContent = prefs.desaturate_amount + "%";
  $("off-note").hidden = prefs.enabled;
  $("main").classList.toggle("off", !prefs.enabled);
  // While CLEAR is off the other controls are shown but cannot be changed.
  for (const el of $("main").querySelectorAll("input, select, button")) {
    if (!prefs.enabled && !el.disabled) { el.disabled = true; el.dataset.off = "1"; }
    else if (prefs.enabled && el.dataset.off) { el.disabled = false; delete el.dataset.off; }
  }
  if (prefs.enabled) $("level").disabled = !prefs.soften_colors;
  $("ai").hidden = !prefs.enable_clarify;
  $("models").hidden = !prefs.enable_clarify;
}

for (const [id, key] of Object.entries(CHECKS)) {
  $(id).addEventListener("change", (e) => { prefs[key] = e.target.checked; render(); save(); });
}
$("level").addEventListener("change", (e) => { prefs.sensory_level = e.target.value; save(); });
$("desat").addEventListener("input", (e) => {
  prefs.desaturate_amount = +e.target.value;
  $("amt").textContent = prefs.desaturate_amount + "%";
  saveSlider();
});

// --- On-device AI status ---------------------------------------------------
const LM_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

async function refreshAi() {
  const text = $("ai-text"), btn = $("ai-btn");
  let state = "unavailable";
  if ("LanguageModel" in self) {
    try { state = await LanguageModel.availability(LM_OPTIONS); } catch (e) {}
  }
  btn.hidden = true;
  if (state === "available") {
    text.textContent = "On-device AI is ready. Selected text stays on this computer.";
  } else if (state === "downloadable") {
    text.textContent = "On-device AI gives better results. It needs a one-time download by Chrome.";
    btn.hidden = false; btn.disabled = false; btn.textContent = "Turn on";
  } else if (state === "downloading") {
    text.textContent = "Chrome is downloading the on-device AI. Basic mode is used until it finishes.";
  } else {
    text.textContent = "On-device AI is not available in this browser, so Explain and Simplify run in basic mode.";
  }
}

$("ai-btn").addEventListener("click", async () => {
  const text = $("ai-text"), btn = $("ai-btn");
  btn.disabled = true;
  text.textContent = "Starting download…";
  try {
    const session = await LanguageModel.create({
      ...LM_OPTIONS,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          text.textContent = "Downloading on-device AI: " + Math.round(e.loaded * 100) + "%";
        });
      },
    });
    session.destroy();
  } catch (e) {
    text.textContent = "The download could not start. Chrome may not support on-device AI on this computer.";
    return;
  }
  refreshAi();
});

// --- CLEAR's own downloadable models ---------------------------------------
// The service worker owns these. The popup only reads the saved state and asks
// it to start or undo a download, so closing the popup never cancels anything.

const MODEL_TEXT = {
  simplify: {
    ready: "Installed. Selected text is rewritten in plainer words on this computer.",
    none: "Not installed. Simplify uses word swaps and sentence splitting only.",
    partial: "Part of this model is in the cache. Download again to finish it.",
  },
  tone: {
    ready: "Installed. Explain also checks whether the text is sarcastic.",
    none: "Not installed. Explain finds idioms, abbreviations and tone markers only.",
    partial: "Part of these models is in the cache. Download again to finish them.",
  },
};

function renderModel(group, state) {
  const row = document.querySelector('.model[data-group="' + group + '"]');
  if (!row) return;
  const m = state && typeof state === "object" ? state : { state: "none" };
  const status = row.querySelector(".model-status");
  const get = row.querySelector(".model-get");
  const remove = row.querySelector(".model-remove");
  const size = row.querySelector(".model-size").textContent;

  get.hidden = m.state === "ready";
  remove.hidden = m.state !== "ready";
  get.disabled = m.state === "downloading";
  get.textContent =
    m.state === "downloading" ? "Downloading " + (m.progress || 0) + "%"
    : m.state === "error" ? "Try again"
    : m.partial ? "Finish download"
    : "Download";

  status.textContent =
    m.state === "ready" ? MODEL_TEXT[group].ready
    : m.state === "downloading" ? "Downloading once from huggingface.co. You can close this popup and keep browsing."
    : m.state === "error" ? "The download failed: " + (m.error || "unknown error") + ". Check your connection and try again."
    : m.partial ? MODEL_TEXT[group].partial
    : MODEL_TEXT[group].none + " One-time download of " + size + ", then it works offline.";
}

function renderModels(all) {
  const states = all && typeof all === "object" ? all : {};
  for (const group of ["simplify", "tone"]) renderModel(group, states[group]);
}

for (const row of document.querySelectorAll(".model")) {
  const group = row.dataset.group;
  row.querySelector(".model-get").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "clear-model-download", group }, () => void chrome.runtime.lastError);
  });
  row.querySelector(".model-remove").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "clear-model-remove", group }, () => void chrome.runtime.lastError);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.clear_models) renderModels(changes.clear_models.newValue);
});

(async () => {
  const stored = await chrome.storage.local.get(["clear_prefs", "clear_models"]);
  prefs = clearNormalizePrefs(stored.clear_prefs);
  render();
  renderModels(stored.clear_models);
  refreshAi();
  // Confirms against the browser cache, so an already-downloaded model is never fetched twice.
  chrome.runtime.sendMessage({ type: "clear-model-check" }, () => void chrome.runtime.lastError);
})();
