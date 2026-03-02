# CLAUDE.md

## Project Overview

Synon is a browser extension that provides a pop-up when selecting words or phrases that defines them with the context of the full tab.

## Architecture

- **manifest.json**: Extension manifest (MV3) — declares `action` popup, `service_worker`, and `content_scripts`
- **src/content.ts** → `dist/content.js`: Injected into every page, detects text selection, sends selected text + page context to background
- **src/background.ts** → `dist/background.js`: Service worker — receives messages from content script, calls AI API, sends definition back
- **src/popup/popup.html** + **src/popup/popup.ts** → `dist/popup/`: UI for saving/viewing API key via `chrome.storage.sync`

## Popup Structure
- When text is selected, a popup is shown -> If the X on that pop-up is clicked, then the popup is deleted, and only shown when reselecting that text
- If text inside the popup itself is selected, a sub-popup is shown. This popup will assume the exact same location of the original, and have a 'back' button to go back to the previous popup. this nesting structure ensues for all nested selection in popups.
- If a word/phrase has more than one meaning, there is are different forward/backward arrows to switch between meanings

## Definition pipeline

- When selecting text there should first be checks as to whether the text is a word/phrase/invalid(empty/gibberish)
- Definition pipeline: Word/Phrase -> Dictionary API -> If Fail, call Wikipedia API -> If Failm, call AI Prompt API

# Exactness & Gibberish Setting
- Gibberish tolerance: Ability to tell whether an actual word or phrase is selected, not just parts of a word or phrase (ex. if rase is selected instead of phrase, do not define)
- In the toolbar have a toggle between Exact Mode on/off
- Exact Mode on: Define all selected text that is not gibberish, even numbers, basic prepositions, and language features (ex. four, the, as, in, of, 2021)
- Exact Mode off: Only define uncommon words and phrases

## Build

- `npm install` — install dependencies
- `npm run build` — bundle TypeScript sources into `dist/` via esbuild
- `npm run watch` — rebuild on file changes
- `npm run typecheck` — run `tsc --noEmit` for type checking

## Loading the Extension

1. Run `npm run build`
2. Open `chrome://extensions`, enable Developer Mode
3. Click "Load unpacked" and select the project root (the folder containing `manifest.json`)
