# CLEAR: Accessible Web Co-Pilot

A Chrome extension that makes busy web pages easier to use.

## What it does
- **Stops autoplay.** Video and sound that start by themselves are paused, whenever they start. Anything you start yourself plays normally. Point at a paused video and press **Play**, or use **Play everything again** in the Page Forecast panel.
- **Stops motion.** CSS and script animations are stopped and GIFs are replaced by a still frame.
- **Reduces color.** One slider (in the popup and in the Page Forecast panel) lowers color intensity for the whole page, from full color to black and white. It changes the page as you drag.
- **Dims images and video.** Optional, three strengths. Text is not affected.
- **Page Forecast.** A small panel that lists what a page contains (videos, moving images, ads, length) and what CLEAR changed.
- **Explain and Simplify.** Select any text, then choose **Explain** or **Simplify** from the small bar that appears, or from the right-click menu.
  - *Explain* gives the plain meaning, lists idioms, jargon and abbreviations with their literal meaning, and describes the tone of a message.
  - *Simplify* rewrites the text in short sentences and common words.

## Explain and Simplify: how it works
CLEAR uses Chrome's built-in on-device AI (Gemini Nano, Prompt API) when the browser has it. Selected text stays on the computer and no account or key is needed. If Chrome shows the model as downloadable, the popup has a **Turn on** button that starts the one-time download.

When on-device AI is not available, CLEAR falls back to a basic offline mode: a built-in list of common idioms, abbreviations and tone markers, plus plain-word swaps and sentence splitting. Each result says which mode produced it.

## Install
1. Unzip, then open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `clear-extension` folder (the one containing `manifest.json`).
4. Reload any tabs that were already open.

## Files
- `manifest.json`: extension config (Manifest V3)
- `defaults.js`: settings shared by all parts
- `content.js`, `styles.css`: everything that happens on a page
- `background.js`: right-click menu, GIF still frames, message routing
- `clarify.js`: Explain and Simplify (on-device AI and offline fallback)
- `popup.html`, `popup.css`, `popup.js`: settings popup

## Privacy
Settings are stored in `chrome.storage.local` on this device. CLEAR sends nothing to any server. The only network request it makes is re-fetching a GIF that is already on the page, to make its still frame.

## Limits
- Chrome blocks extensions on `chrome://` pages and the Chrome Web Store.
- Media inside a site's closed shadow DOM, and sound played without an audio element on the page, cannot be paused.
- Animated WebP and APNG images are not frozen.


## On-device AI (added in 1.2.0)

Explain and Simplify now try three engines, in this order:

1. **Chrome's built-in AI** (Prompt API), when the browser has it.
2. **CLEAR's own models**, if you downloaded them from the popup under "CLEAR's own models":
   - Simplify model: `Xenova/LaMini-Flan-T5-248M` (about 270 MB) rewrites text in plainer words.
   - Sarcasm models: `Xenova/twitter-roberta-base-irony` and `Xenova/distilbert-base-uncased-finetuned-sst-2-english` (about 194 MB together). Explain adds a "Sarcasm check" line only when praise with nothing in it ("Fantastic") sits next to a clause the sentiment model reads as bad ("the printer is jammed"). Neither model may claim sarcasm on its own, and a clause that says things went well ("the bug is fixed now") never counts as bad.
3. **Built-in rules** (word swaps, idiom and abbreviation look-up).

How the models are stored and checked:

- They run in a hidden extension page (`ai/offscreen.html`) through Transformers.js and ONNX Runtime (bundled in `vendor/`). Text never leaves the computer; only the model files are downloaded, once, from huggingface.co.
- Files are kept in the browser cache. On install, on browser start and whenever the popup opens, CLEAR checks the cache, so a model that is already there is never downloaded again. A half-finished download shows "Finish download".
- Update CLEAR with the reload arrow on `chrome://extensions`. Pressing Remove deletes the cache, and loading the folder from a different path gives the extension a new ID with an empty cache.
- `models.js` is the service worker side (state, download, cache check). `ai/sarcasm.js` holds the clause logic.

## Added in 1.3.0

- **Master switch** at the top of the popup. Off means CLEAR changes nothing on any page, the right-click entries disappear and the toolbar icon shows "off". Settings are kept and come back when it is switched on.
- **Blur pictures and video until I point at them** (popup, under Color). Off by default. Pictures smaller than 80 pixels (icons, logos, avatars) stay sharp.
- **GIF pausing fixes.** Moving pictures are now recognised by looking at the file, not only at a `.gif` ending, so animated WebP, animated PNG and addresses with no ending are paused too. Pictures that a page swaps in later (lazy loading) are now caught, and one-pixel placeholders are ignored.
