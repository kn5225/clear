// CLEAR: Explain & Simplify engine (runs in the background service worker).
//
// 1. Preferred: Chrome's built-in on-device AI (Prompt API / Gemini Nano).
//    Text never leaves the computer and no account or key is needed.
// 2. Fallback: a small offline rule set (plain-word swaps, sentence splitting,
//    idiom and abbreviation look-up) so the feature still does something
//    useful when the on-device model is not available.

const CLEAR_LM_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

const CLEAR_SYSTEM_PROMPTS = {
  simplify:
    "You rewrite text in plain language for readers who find dense or complicated writing hard to follow. " +
    "Keep every fact, number, name, date and instruction. Use short sentences and common words. " +
    "If a technical term is needed, keep it and explain it in brackets the first time. " +
    "Use a short list when the text gives steps or several items. " +
    "Do not add opinions, advice or new information. Reply with only the rewritten text, no introduction.",
  explain:
    "You explain text clearly and literally for readers who may find it confusing. " +
    "Reply in plain text using exactly these labelled parts, skipping any part that does not apply:\n" +
    "What it means: one to three short, plain sentences.\n" +
    "Tricky parts: a list with one line per idiom, figure of speech, piece of jargon, abbreviation or implied meaning, each followed by its literal meaning.\n" +
    "Tone: one short line, only if the text is a message written by a person (for example friendly, joking, sarcastic, annoyed, formal). Say so if the tone is unclear.\n" +
    "What to do: only if the text asks the reader to do something.\n" +
    "Do not guess beyond the text. If something is ambiguous, say that it is ambiguous. No introduction.",
};

const CLEAR_MAX_INPUT = 6000;

async function clearAiAvailability() {
  if (!("LanguageModel" in self)) return "unavailable";
  try {
    return await LanguageModel.availability(CLEAR_LM_OPTIONS);
  } catch (e) {
    return "unavailable";
  }
}

async function clearRunAi(mode, text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let session;
  try {
    session = await LanguageModel.create({
      ...CLEAR_LM_OPTIONS,
      initialPrompts: [{ role: "system", content: CLEAR_SYSTEM_PROMPTS[mode] }],
      signal: controller.signal,
    });
    const out = await session.prompt('Text:\n"""\n' + text + '\n"""', { signal: controller.signal });
    return (out || "").trim();
  } finally {
    clearTimeout(timer);
    try { session && session.destroy(); } catch (e) {}
  }
}

// --- Offline fallback ------------------------------------------------------

const CLEAR_PLAIN_WORDS = [
  ["at this point in time", "now"], ["at the present time", "now"], ["in the event that", "if"],
  ["due to the fact that", "because"], ["in spite of the fact that", "although"], ["for the purpose of", "to"],
  ["with regard to", "about"], ["with respect to", "about"], ["in relation to", "about"], ["in order to", "to"],
  ["in the near future", "soon"], ["a number of", "several"], ["a large number of", "many"],
  ["the majority of", "most"], ["on a regular basis", "regularly"], ["in addition to", "besides"],
  ["as a consequence of", "because of"], ["in accordance with", "following"], ["prior to", "before"],
  ["subsequent to", "after"], ["in lieu of", "instead of"], ["by means of", "by"], ["is able to", "can"],
  ["are able to", "can"], ["has the ability to", "can"], ["make a decision", "decide"],
  ["take into consideration", "consider"], ["until such time as", "until"], ["notwithstanding", "despite"],
  ["utilize", "use"], ["utilise", "use"], ["utilization", "use"], ["commence", "start"], ["commencement", "start"],
  ["terminate", "end"], ["termination", "end"], ["approximately", "about"], ["purchase", "buy"],
  ["assistance", "help"], ["sufficient", "enough"], ["insufficient", "not enough"], ["numerous", "many"],
  ["endeavor", "try"], ["endeavour", "try"], ["regarding", "about"],
  ["concerning", "about"], ["additional", "more"], ["obtain", "get"], ["acquire", "get"], ["require", "need"],
  ["requirement", "need"], ["demonstrate", "show"], ["indicate", "show"], ["subsequently", "later"],
  ["consequently", "so"], ["therefore", "so"], ["however", "but"], ["furthermore", "also"], ["moreover", "also"],
  ["nevertheless", "even so"], ["commonly", "often"], ["frequently", "often"], ["initiate", "start"],
  ["implement", "carry out"], ["modify", "change"], ["modification", "change"], ["attempt", "try"],
  ["inform", "tell"], ["notify", "tell"], ["request", "ask for"], ["provide", "give"], ["retain", "keep"],
  ["reside", "live"], ["residence", "home"], ["ascertain", "find out"], ["determine", "find out"],
  ["verify", "check"], ["component", "part"], ["proceed", "go ahead"], ["remainder", "rest"],
  ["expedite", "speed up"], ["mandatory", "required"], ["optimal", "best"], ["optimum", "best"],
  ["primarily", "mainly"], ["immediately", "right away"], ["currently", "now"], ["previously", "before"],
  ["eligible", "allowed"], ["remuneration", "pay"], ["discontinue", "stop"], ["cease", "stop"],
  ["adjacent to", "next to"], ["in excess of", "more than"], ["whilst", "while"], ["thus", "so"],
  ["hence", "so"], ["via", "through"], ["per annum", "a year"], ["elucidate", "explain"],
];

const CLEAR_IDIOMS = [
  ["break a leg", "good luck"], ["piece of cake", "very easy"], ["under the weather", "feeling a bit ill"],
  ["hit the nail on the head", "be exactly right"], ["touch base", "make contact briefly"],
  ["circle back", "return to this topic later"], ["ballpark figure", "a rough estimate"],
  ["ballpark", "a rough estimate"], ["on the same page", "in agreement, understanding things the same way"],
  ["once in a blue moon", "very rarely"], ["cost an arm and a leg", "be very expensive"],
  ["costs an arm and a leg", "is very expensive"], ["bite the bullet", "do something unpleasant that has to be done"],
  ["beat around the bush", "avoid saying something directly"], ["the ball is in your court", "it is your turn to decide or act"],
  ["ball is in your court", "it is your turn to decide or act"], ["call it a day", "stop working for today"],
  ["cut corners", "do something badly to save time or money"], ["get out of hand", "become hard to control"],
  ["hang in there", "keep going, do not give up"], ["in the loop", "kept informed"], ["out of the loop", "not informed"],
  ["keep me posted", "tell me when something changes"], ["let the cat out of the bag", "reveal a secret"],
  ["miss the boat", "be too late for an opportunity"], ["no pain no gain", "effort is needed to improve"],
  ["on the fence", "undecided"], ["pull someone's leg", "joke with someone"], ["pulling your leg", "joking with you"],
  ["pulling my leg", "joking with me"], ["speak of the devil", "the person we were talking about just arrived"],
  ["the last straw", "the final problem that makes a situation unbearable"], ["time flies", "time passes quickly"],
  ["up in the air", "not decided yet"], ["a blessing in disguise", "something good that seemed bad at first"],
  ["back to square one", "starting again from the beginning"], ["back to the drawing board", "starting the plan again"],
  ["barking up the wrong tree", "looking for the cause in the wrong place"], ["burn the midnight oil", "work late into the night"],
  ["cross that bridge when we come to it", "deal with that problem only if it happens"],
  ["easier said than done", "it sounds simple but is hard to do"], ["get the ball rolling", "start something"],
  ["give the benefit of the doubt", "choose to trust someone without proof"], ["go the extra mile", "do more than is expected"],
  ["in a nutshell", "in summary"], ["it's not rocket science", "it is not complicated"],
  ["jump on the bandwagon", "join something because it is popular"], ["long story short", "in summary"],
  ["low-hanging fruit", "the easiest tasks to do first"], ["move the needle", "make a noticeable difference"],
  ["take it with a grain of salt", "do not fully believe it"], ["take with a grain of salt", "do not fully believe it"],
  ["think outside the box", "think in a new or creative way"], ["raise the bar", "set a higher standard"],
  ["red tape", "slow official rules and paperwork"], ["rule of thumb", "a rough, practical guide"],
  ["heads up", "an advance warning"], ["heads-up", "an advance warning"], ["no worries", "that is fine, it is not a problem"],
  ["my bad", "that was my mistake"], ["at the end of the day", "when everything is considered"],
  ["going forward", "from now on"], ["take this offline", "discuss this later, outside this meeting or thread"],
  ["per my last email", "I already said this (often shows the writer is annoyed)"],
  ["as per my last email", "I already said this (often shows the writer is annoyed)"],
  ["with all due respect", "I am about to disagree with you"], ["no offense", "I am about to say something that may offend"],
  ["no offence", "I am about to say something that may offend"], ["just saying", "softens a criticism the writer just made"],
  ["i'm dead", "I find this very funny"], ["spill the tea", "share the gossip"], ["low-key", "a little, quietly"],
  ["ghosted", "stopped replying without explanation"], ["rain check", "a polite way to postpone"],
  ["bandwidth", "time or energy to take on work (when said about a person)"], ["ping me", "send me a short message"],
  ["deep dive", "a detailed look"], ["pain point", "a problem that bothers someone"], ["game changer", "something that changes a lot"],
];

const CLEAR_ABBREVIATIONS = [
  ["ASAP", "as soon as possible"], ["FYI", "for your information (no action needed)"], ["EOD", "end of the working day"],
  ["COB", "close of business, the end of the working day"], ["EOW", "end of the week"], ["TBD", "to be decided"],
  ["TBC", "to be confirmed"], ["TBA", "to be announced"], ["ETA", "expected time of arrival or completion"],
  ["IMO", "in my opinion"], ["IMHO", "in my humble opinion"], ["AFAIK", "as far as I know"], ["IIRC", "if I remember correctly"],
  ["TL;DR", "summary of a long text"], ["TLDR", "summary of a long text"], ["BTW", "by the way"], ["IDK", "I don't know"],
  ["TBH", "to be honest"], ["NGL", "not going to lie (honestly)"], ["IRL", "in real life"], ["DM", "direct (private) message"],
  ["OOO", "out of office, not working"], ["WFH", "working from home"], ["RSVP", "please reply to say if you are coming"],
  ["N/A", "not applicable, does not apply"], ["i.e.", "that is, in other words"], ["e.g.", "for example"],
  ["etc.", "and other similar things"], ["vs.", "against, compared with"], ["NB", "note this, it is important"],
  ["PTO", "paid time off work"], ["LMK", "let me know"], ["JK", "just kidding, I was joking"], ["SMH", "shaking my head (disapproval)"],
  ["LOL", "laughing (shows the message is light-hearted)"], ["IYKYK", "only some people will understand this"],
  ["FWIW", "for what it's worth (here is my small contribution)"], ["WRT", "with regard to, about"], ["AKA", "also known as"],
  ["DIY", "do it yourself"], ["FAQ", "frequently asked questions"], ["T&Cs", "terms and conditions"],
];

function clearEscapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function clearMatchCase(original, replacement) {
  if (original === original.toUpperCase() && /[A-Z]/.test(original) && original.length > 1) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function clearPlainWords(text) {
  let out = text;
  const swaps = [];
  // Longest phrases first so "in order to" wins over shorter overlaps.
  const list = [...CLEAR_PLAIN_WORDS].sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of list) {
    const re = new RegExp("\\b" + clearEscapeRe(from) + "(s|d|ed|es)?\\b", "gi");
    out = out.replace(re, (m, suffix) => {
      // Only inflect single-word swaps, and only with a simple plural/3rd person "s".
      if (suffix && (to.includes(" ") || !/^(s|es)$/i.test(suffix))) return m;
      swaps.push(from);
      const base = clearMatchCase(m, to);
      return suffix ? base + "s" : base;
    });
  }
  return { text: out, swaps };
}

function clearSplitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=["'“(\[]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function clearShorten(sentence) {
  // Break long sentences at natural joins so each line carries one idea.
  if (sentence.split(" ").length < 22) return [sentence];
  const parts = sentence
    .split(/;\s+|\s+[–—]\s+|,\s+(?=(?:and|but|so|because|which|while|although|though|whereas)\b)/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return [sentence];
  return parts.map((p, i) => {
    let s = p.replace(/^(and|which)\s+/i, "");
    s = s[0].toUpperCase() + s.slice(1);
    if (i < parts.length - 1 && !/[.!?:]$/.test(s)) s += ".";
    return s;
  });
}

function clearBasicSimplify(text) {
  const plain = clearPlainWords(text).text;
  const lines = [];
  for (const s of clearSplitSentences(plain)) lines.push(...clearShorten(s));
  return lines.join("\n");
}

function clearFindTricky(text) {
  const found = [];
  const seen = new Set();
  const lower = text.toLowerCase();
  for (const [phrase, meaning] of [...CLEAR_IDIOMS].sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp("(^|[^a-z])" + clearEscapeRe(phrase) + "($|[^a-z])", "i");
    if (re.test(lower) && ![...seen].some((p) => p.includes(phrase))) {
      seen.add(phrase);
      found.push('"' + phrase + '" means: ' + meaning + ".");
    }
  }
  for (const [abbr, meaning] of CLEAR_ABBREVIATIONS) {
    // Abbreviations are matched case-sensitively, except chat ones typed in lower case.
    const re = new RegExp("(^|[^A-Za-z])" + clearEscapeRe(abbr) + "($|[^A-Za-z])");
    const reLower = new RegExp("(^|[^A-Za-z])" + clearEscapeRe(abbr.toLowerCase()) + "($|[^A-Za-z])");
    const chatty = /^(ASAP|FYI|IMO|IMHO|AFAIK|IIRC|TLDR|BTW|IDK|TBH|NGL|IRL|LMK|JK|SMH|LOL|IYKYK|FWIW|WFH|OOO)$/.test(abbr);
    if (re.test(text) || (chatty && reLower.test(text))) found.push(abbr + " means: " + meaning + ".");
  }
  return found;
}

function clearToneCues(text) {
  const cues = [];
  if (/(^|\s)\/s(\s|$)/.test(text)) cues.push('"/s" marks the message as sarcasm: the writer means the opposite.');
  if (/(^|\s)\/j(\s|$)/.test(text)) cues.push('"/j" marks the message as a joke.');
  if (/(^|\s)\/srs(\s|$)/.test(text)) cues.push('"/srs" marks the message as serious.');
  const caps = text.match(/\b[A-Z]{4,}\b/g) || [];
  if (caps.length >= 3) cues.push("Several words are in capital letters, which usually shows strong feeling or shouting.");
  if (/!{2,}/.test(text)) cues.push("Repeated exclamation marks usually show excitement or strong feeling.");
  if (/\?{2,}|\?!|!\?/.test(text)) cues.push("Repeated question marks usually show surprise or disbelief.");
  if (/\.\.\.\s*$/.test(text.trim())) cues.push("Ending with \"...\" can mean the writer is unsure, or leaving something unsaid.");
  return cues;
}

function clearBasicExplain(text) {
  const tricky = clearFindTricky(text);
  const tone = clearToneCues(text);
  const out = [];
  if (tricky.length) out.push("Tricky parts:\n" + tricky.map((t) => "• " + t).join("\n"));
  if (tone.length) out.push("Tone clues:\n" + tone.map((t) => "• " + t).join("\n"));
  if (!tricky.length && !tone.length) out.push("No common idioms, abbreviations or tone markers were found in this text.");
  const simple = clearBasicSimplify(text);
  if (simple.replace(/\s+/g, " ") !== text.replace(/\s+/g, " ").trim()) out.push("In plainer words:\n" + simple);
  return out.join("\n\n");
}

// --- Entry point -----------------------------------------------------------

async function clearClarify(mode, rawText) {
  mode = mode === "explain" ? "explain" : "simplify";
  let text = String(rawText || "").trim();
  if (!text) return { ok: false, error: "No text was selected." };
  let truncated = false;
  if (text.length > CLEAR_MAX_INPUT) { text = text.slice(0, CLEAR_MAX_INPUT); truncated = true; }

  // 1. Chrome's own on-device model, when this browser has one.
  const availability = await clearAiAvailability();
  if (availability === "available") {
    try {
      const out = await clearRunAi(mode, text);
      if (out) {
        return {
          ok: true, engine: "ai", text: out, truncated, availability,
          note: "Written by Chrome's built-in AI on this device. It can make mistakes.",
        };
      }
    } catch (e) {
      // fall through
    }
  }

  // 2. The models CLEAR can download itself, if the user installed them.
  const haveModels = typeof clearModelSimplify === "function";
  let modelTried = false;
  if (haveModels && mode === "simplify") {
    try {
      const r = await clearModelSimplify(text);
      modelTried = !!r;
      if (r && r.changed > 0) {
        return {
          ok: true, engine: "model", text: r.text, truncated, availability,
          note: "Rewritten by the downloaded on-device model. Small models can change details, so check names, numbers and dates against the original.",
        };
      }
    } catch (e) {
      // fall through
    }
  }

  let sarcasm = null;
  if (haveModels && mode === "explain") {
    try {
      sarcasm = await clearModelTone(text);
      modelTried = sarcasm !== null || (await clearModelReady("tone"));
    } catch (e) {}
  }

  // 3. The built-in rules.
  let out = mode === "explain" ? clearBasicExplain(text) : clearBasicSimplify(text);
  if (sarcasm) {
    out = "Sarcasm check:\n• " + sarcasm + "\n\n" + out;
    return {
      ok: true, engine: "model", text: out, truncated, availability,
      note: "Sarcasm was checked by the downloaded on-device models. The rest uses CLEAR's built-in rules.",
    };
  }
  // Say plainly which of the three did the work, so the card never claims a
  // model is missing when one is installed but had nothing to add.
  let note;
  if (modelTried) {
    note = mode === "simplify"
      ? "Basic mode: the downloaded model had no usable rewrite for this text, so CLEAR's own word swaps were used."
      : "The downloaded models found no sign of sarcasm. The rest uses CLEAR's built-in rules.";
  }
  return { ok: true, engine: "basic", text: out, truncated, availability, note };
}

if (typeof module !== "undefined") {
  module.exports = { clearClarify, clearBasicSimplify, clearBasicExplain };
}
