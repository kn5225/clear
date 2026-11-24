// CLEAR: downloadable on-device models.
//
// Runs in a hidden extension page so a slow model never blocks the service
// worker or the page you are reading. Two groups, each downloaded only when
// you ask for it and then kept in the browser's cache:
//
//   simplify  Xenova/LaMini-Flan-T5-248M
//             a small instruction model that rewrites text in plainer words.
//   tone      Xenova/twitter-roberta-base-irony
//             Xenova/distilbert-base-uncased-finetuned-sst-2-english
//             read together to spot sarcasm.
//
// Text is processed on this computer. Only the model files are downloaded.

import { pipeline, env } from "../vendor/transformers.min.js";

const MODELS = {
  lamini: { task: "text2text-generation", id: "Xenova/LaMini-Flan-T5-248M" },
  irony: { task: "text-classification", id: "Xenova/twitter-roberta-base-irony" },
  sentiment: { task: "text-classification", id: "Xenova/distilbert-base-uncased-finetuned-sst-2-english" },
};

// What the user downloads as one item, and each part's share of the progress bar.
const GROUPS = {
  simplify: [["lamini", 1]],
  tone: [["irony", 0.65], ["sentiment", 0.35]],
};

// The weight file that proves a model is already in the cache.
const WEIGHTS = {
  lamini: ["onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"],
  irony: ["onnx/model_quantized.onnx"],
  sentiment: ["onnx/model_quantized.onnx"],
};

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/");
env.backends.onnx.wasm.numThreads = 1;

const pipes = {};
const loading = {};
const lastPct = {};
let idleTimer = 0;

const tell = (msg) => {
  try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (e) {}
};

function loadOne(name, host, onPct) {
  if (pipes[name]) return Promise.resolve(pipes[name]);
  if (loading[name]) return loading[name];
  if (host) env.remoteHost = host;
  const m = MODELS[name];
  loading[name] = pipeline(m.task, m.id, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p) => { if (p.status === "progress_total" && onPct) onPct(p.progress); },
  }).then(
    (p) => { pipes[name] = p; delete loading[name]; return p; },
    (e) => { delete loading[name]; throw e; }
  );
  return loading[name];
}

async function load(group, host) {
  let done = 0;
  for (const [name, share] of GROUPS[group]) {
    await loadOne(name, host, (pct) => {
      const total = Math.floor((done + (share * pct) / 100) * 100);
      if (total !== lastPct[group]) {
        lastPct[group] = total;
        tell({ type: "clear-model-progress", group, progress: total });
      }
    });
    done += share;
  }
}

// --- Sarcasm ---------------------------------------------------------------
// Two signals, reported separately. Neither is allowed to claim sarcasm on its
// own: the irony classifier rates most cheerful text as ironic, and a sentiment
// classifier reads words rather than situations, so "the bug is fixed now"
// scores negative on the word "bug". The caller requires a conflict.

const pick = (labels, yes, no) => {
  const list = Array.isArray(labels) ? labels : [labels];
  const hit = list.find((l) => yes.test(l.label) && !/non|not/i.test(l.label));
  if (hit) return hit.score;
  const miss = list.find((l) => no.test(l.label));
  return miss ? 1 - miss.score : 0;
};

async function readTone(texts, host) {
  await load("tone", host);
  texts = texts.map((t) => String(t).slice(0, 1200));
  const irony = (await pipes.irony(texts, { top_k: 2 })).map((l) =>
    pick(l, /irony|sarcas|(^|_)1$/i, /non|not|(^|_)0$/i)
  );
  const plans = texts.map((t) => globalThis.CLEAR_SARCASM.plan(t));
  const jobs = []; // [textIndex, clauseIndex]
  plans.forEach((p, ti) => {
    if (p.bare.length && !p.blocked) for (const ci of p.rest) if (jobs.length < 32) jobs.push([ti, ci]);
  });
  const neg = texts.map(() => ({}));
  if (jobs.length) {
    const out = await pipes.sentiment(jobs.map(([ti, ci]) => plans[ti].cs[ci]), { top_k: 2 });
    out.forEach((l, k) => { neg[jobs[k][0]][jobs[k][1]] = pick(l, /neg|(^|_)0$/i, /pos|(^|_)1$/i); });
  }
  return texts.map((t, i) => {
    const c = globalThis.CLEAR_SARCASM.contrast(plans[i], neg[i]);
    return {
      irony: irony[i],
      bare: plans[i].bare.length > 0 && !plans[i].blocked,
      conflict: c ? c.strength : null,
      positive: c ? c.positive : null,
      negative: c ? c.negative : null,
    };
  });
}

// --- Simplify --------------------------------------------------------------
// A few sentences at a time, which small models handle far better than a wall
// of text. A piece is left exactly as it was when the model returns nothing
// usable for it, so the output never loses content.

const wordCount = (t) => (t.match(/\S+/g) || []).length;

function chunk(text) {
  const parts = text.split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  let cur = "";
  for (const s of parts) {
    if (cur && wordCount(cur) + wordCount(s) > 45) { out.push(cur); cur = s; }
    else cur = cur ? cur + " " + s : s;
  }
  if (cur) out.push(cur);
  return out.slice(0, 14);
}

async function simplify(text, host) {
  await load("simplify", host);
  const out = [];
  let changed = 0;
  for (const c of chunk(String(text).slice(0, 3000))) {
    let r = "";
    try {
      const g = await pipes.lamini(
        "Rewrite the following text using simple words and short sentences. Keep every fact.\n\n" + c,
        {
          max_new_tokens: Math.min(220, Math.round(wordCount(c) * 1.8) + 24),
          do_sample: false,
          repetition_penalty: 1.2,
          no_repeat_ngram_size: 4,
        }
      );
      r = String((Array.isArray(g) ? g[0] : g).generated_text || "").replace(/<\/?(?:pad|s|unk)>/g, " ").replace(/\s+/g, " ").trim();
    } catch (e) {
      r = "";
    }
    const ok = r && wordCount(r) >= Math.max(2, wordCount(c) * 0.3) && wordCount(r) <= wordCount(c) * 2 + 10;
    if (ok && r !== c) changed++;
    out.push(ok ? r : c);
  }
  return { text: out.join(" "), changed };
}

// --- Cache check -----------------------------------------------------------
// have: every weight file for the group is in the cache, so nothing is
//       downloaded again, even after a browser restart or a CLEAR update.
// some: part of it is there (an interrupted download, or an older CLEAR that
//       needed fewer files).

async function probe() {
  const have = {}, some = {};
  try {
    const cache = await caches.open(env.cacheKey || "transformers-cache");
    const urls = (await cache.keys()).map((r) => r.url);
    for (const group of Object.keys(GROUPS)) {
      const found = [];
      for (const [name] of GROUPS[group]) {
        for (const f of WEIGHTS[name]) found.push(urls.some((u) => u.includes(MODELS[name].id) && u.endsWith(f)));
      }
      have[group] = found.every(Boolean);
      some[group] = found.some(Boolean);
    }
  } catch (e) {}
  return { have, some };
}

async function removeGroup(group) {
  const cache = await caches.open(env.cacheKey || "transformers-cache");
  let n = 0;
  for (const [name] of GROUPS[group]) {
    delete pipes[name];
    for (const req of await cache.keys()) {
      if (req.url.includes(MODELS[name].id)) { await cache.delete(req); n++; }
    }
  }
  return n;
}

// --- Messages --------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Every extension page receives every runtime message. Only answer our own.
  if (!msg || msg.target !== "clear-offscreen") return;

  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!Object.keys(loading).length) window.close(); }, 10 * 60 * 1000);

  (async () => {
    try {
      if (msg.type === "load") {
        await load(msg.group, msg.host);
        tell({ type: "clear-model-done", group: msg.group, ok: true });
        sendResponse({ ok: true });
      } else if (msg.type === "tone") {
        sendResponse({ ok: true, results: await readTone(msg.texts, msg.host) });
      } else if (msg.type === "simplify") {
        sendResponse(Object.assign({ ok: true }, await simplify(msg.text, msg.host)));
      } else if (msg.type === "probe") {
        sendResponse(Object.assign({ ok: true }, await probe()));
      } else if (msg.type === "remove") {
        sendResponse({ ok: true, removed: await removeGroup(msg.group) });
      } else {
        sendResponse({ ok: false, error: "unknown request" });
      }
    } catch (e) {
      const error = String((e && e.message) || e).slice(0, 200);
      if (msg.type === "load") tell({ type: "clear-model-done", group: msg.group, ok: false, error });
      sendResponse({ ok: false, error });
    }
  })();
  return true; // async response
});
