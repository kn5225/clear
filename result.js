// CLEAR: stand-alone result window. Used when the card cannot be shown inside
// a page (browser pages, the Web Store, PDF viewer, or a page that blocks it).
const $ = (id) => document.getElementById(id);
const TITLE = { explain: "Explained", simplify: "Simplified" };
let mode = new URLSearchParams(location.search).get("mode") === "simplify" ? "simplify" : "explain";
let text = "";
try { text = decodeURIComponent(location.hash.slice(1)); } catch (e) {}

function tidy(t) {
  return String(t || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^\s*[*-]\s+/gm, "• ").trim();
}

let token = 0;
async function run() {
  const mine = ++token;
  $("title").textContent = TITLE[mode];
  $("switch").textContent = mode === "explain" ? "Simplify instead" : "Explain instead";
  $("original").textContent = text;
  $("body").textContent = "Working on it…";
  $("note").hidden = true;
  let res = null;
  try { res = await chrome.runtime.sendMessage({ type: "clarify", mode, text }); } catch (e) {}
  if (mine !== token) return;
  if (!res || !res.ok) { $("body").textContent = (res && res.error) || "CLEAR could not process this text."; return; }
  $("body").textContent = tidy(res.text);
  const notes = [];
  if (res.note) notes.push(res.note);
  else notes.push("Basic mode: no on-device model is installed, so only common phrases and wording are handled. The CLEAR popup can download one.");
  if (res.truncated) notes.push("Only the first part of a long selection was used.");
  $("note").textContent = notes.join(" ");
  $("note").hidden = false;
}

$("switch").addEventListener("click", () => { mode = mode === "explain" ? "simplify" : "explain"; run(); });
$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("body").textContent); $("copy").textContent = "Copied"; }
  catch (e) { $("copy").textContent = "Could not copy"; }
  setTimeout(() => { $("copy").textContent = "Copy"; }, 1500);
});
run();
