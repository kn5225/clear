// CLEAR: manager for the downloadable on-device models.
//
// The models themselves run in a hidden page (ai/offscreen.html). This file is
// the service worker's side of that: it remembers what is installed, starts and
// reports downloads, and answers the popup.
//
// Nothing is downloaded unless the user asks for it. Before any download starts
// the browser cache is checked, so a model that is already there is never
// fetched a second time, including after a browser restart or a CLEAR update.

const CLEAR_MODEL_GROUPS = ["simplify", "tone"];
const CLEAR_MODEL_KEY = "clear_models";
const CLEAR_MODEL_SIZES = { simplify: "about 270 MB", tone: "about 194 MB" };

function clearBlankModelState() {
  const out = {};
  for (const g of CLEAR_MODEL_GROUPS) out[g] = { state: "none" };
  return out;
}

async function clearGetModels() {
  const stored = (await chrome.storage.local.get([CLEAR_MODEL_KEY]))[CLEAR_MODEL_KEY];
  const out = clearBlankModelState();
  if (stored && typeof stored === "object") {
    for (const g of CLEAR_MODEL_GROUPS) {
      const v = stored[g];
      if (v && typeof v === "object" && typeof v.state === "string") out[g] = v;
    }
  }
  return out;
}

async function clearSetModel(group, value) {
  const all = await clearGetModels();
  all[group] = value;
  await chrome.storage.local.set({ [CLEAR_MODEL_KEY]: all });
}

// Test hook only. Never set in normal use; lets a local copy of the model files
// be used instead of huggingface.co.
async function clearModelHost() {
  return (await chrome.storage.local.get(["clear_model_host"])).clear_model_host || undefined;
}

// --- The hidden page -------------------------------------------------------

let clearOffscreenReady = null;

function clearEnsureOffscreen() {
  if (!clearOffscreenReady) {
    clearOffscreenReady = (async () => {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: "ai/offscreen.html",
        reasons: ["WORKERS"],
        justification: "Runs the on-device language models that simplify text and read tone.",
      });
    })().finally(() => { clearOffscreenReady = null; });
  }
  return clearOffscreenReady;
}

function clearToOffscreen(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ target: "clear-offscreen" }, msg), (r) => {
      void chrome.runtime.lastError;
      resolve(r || null);
    });
  });
}

// --- Install, check, remove ------------------------------------------------

async function clearModelDownload(group) {
  if (!CLEAR_MODEL_GROUPS.includes(group)) return;
  const all = await clearGetModels();
  const st = all[group];
  if (st.state === "downloading" && Date.now() - (st.at || 0) < 20000) return; // already running
  await clearSetModel(group, { state: "downloading", progress: 0, at: Date.now() });
  try {
    await clearEnsureOffscreen();
    clearToOffscreen({ type: "load", group, host: await clearModelHost() }); // reports back as it goes
  } catch (e) {
    await clearSetModel(group, { state: "error", error: String((e && e.message) || e).slice(0, 200) });
  }
}

async function clearModelRemove(group) {
  if (!CLEAR_MODEL_GROUPS.includes(group)) return;
  try {
    await clearEnsureOffscreen();
    await clearToOffscreen({ type: "remove", group });
  } catch (e) {}
  await clearSetModel(group, { state: "none" });
}

// Reconciles what is saved with what is actually in the cache, so a model is
// never downloaded twice and a half-finished one is not reported as ready.
let clearProbing = null;

function clearModelCheck() {
  if (!clearProbing) {
    clearProbing = (async () => {
      const all = await clearGetModels();
      for (const g of CLEAR_MODEL_GROUPS) {
        // A download that was interrupted by a browser restart is not still running.
        if (all[g].state === "downloading" && Date.now() - (all[g].at || 0) > 60000) {
          all[g] = { state: "none" };
          await clearSetModel(g, all[g]);
        }
      }
      if (CLEAR_MODEL_GROUPS.every((g) => all[g].state === "downloading")) return;
      await clearEnsureOffscreen();
      const r = await clearToOffscreen({ type: "probe" });
      if (!r || !r.ok) return;
      for (const g of CLEAR_MODEL_GROUPS) {
        if (all[g].state === "downloading") continue;
        if (r.have[g] && all[g].state !== "ready") await clearSetModel(g, { state: "ready" });
        else if (!r.have[g] && all[g].state === "ready") await clearSetModel(g, { state: "none", partial: !!r.some[g] });
        else if (!r.have[g] && r.some[g] && all[g].state === "none" && !all[g].partial) {
          await clearSetModel(g, { state: "none", partial: true });
        }
      }
    })().catch(() => {}).finally(() => { clearProbing = null; });
  }
  return clearProbing;
}

// --- Using the models ------------------------------------------------------

async function clearModelReady(group) {
  return (await clearGetModels())[group].state === "ready";
}

// Plain-language rewrite. Returns null when the model is not installed.
async function clearModelSimplify(text) {
  if (!(await clearModelReady("simplify"))) return null;
  await clearEnsureOffscreen();
  const r = await clearToOffscreen({ type: "simplify", text, host: await clearModelHost() });
  if (!r || !r.ok || !r.text) return null;
  return { text: r.text, changed: r.changed };
}

// One line about tone, or null. A model is never allowed to claim sarcasm on
// its own: the irony classifier calls most cheerful writing ironic, and the
// sentiment classifier reads words rather than situations. A line is produced
// only when praise with nothing in it sits next to a situation the sentiment
// model reads as bad, which is the shape real sarcasm almost always takes.
async function clearModelTone(text) {
  if (!(await clearModelReady("tone"))) return null;
  await clearEnsureOffscreen();
  const r = await clearToOffscreen({ type: "tone", texts: [String(text).slice(0, 1200)], host: await clearModelHost() });
  if (!r || !r.ok || !r.results || !r.results[0]) return null;
  const t = r.results[0];
  if (t.conflict == null) return null;
  const pct = Math.round(t.irony * 100);
  const firm = t.irony >= 0.6;
  return (
    (firm ? "This reads as sarcastic" : "This may be sarcastic") +
    ': the praise ("' + t.positive + '") sits next to a bad situation ("' + t.negative + '"), ' +
    "and the irony model rates it " + pct + "% likely to be sarcastic. " +
    "If it is sarcasm, the writer means roughly the opposite of the words."
  );
}

// --- Messages --------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target === "clear-offscreen") return; // not for us

  if (msg.type === "clear-model-progress") {
    clearGetModels().then((all) => {
      if (all[msg.group] && all[msg.group].state === "downloading") {
        clearSetModel(msg.group, { state: "downloading", progress: msg.progress, at: Date.now() });
      }
    });
    return;
  }
  if (msg.type === "clear-model-done") {
    clearSetModel(
      msg.group,
      msg.ok ? { state: "ready" } : { state: "error", error: msg.error || "The model could not be loaded." }
    );
    return;
  }
  if (msg.type === "clear-model-download") { clearModelDownload(msg.group); sendResponse({ ok: true }); return; }
  if (msg.type === "clear-model-remove") { clearModelRemove(msg.group).then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === "clear-model-check") { clearModelCheck().then(() => sendResponse({ ok: true })); return true; }
});
