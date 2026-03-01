# CLAUDE.md

## Project Overview

Synon is a browser extension that provides a pop-up when selecting words or phrases that defines them with the context of the full tab.

## Architecture

- **manifest.json**: Extension manifest (MV3) — declares `action` popup, `service_worker`, and `content_scripts`
- **src/content.ts** → `dist/content.js`: Injected into every page, detects text selection, sends selected text + page context to background
- **src/background.ts** → `dist/background.js`: Service worker — receives messages from content script, calls AI API, sends definition back
- **src/popup/popup.html** + **src/popup/popup.ts** → `dist/popup/`: UI for saving/viewing API key via `chrome.storage.sync`

## Build

- `npm install` — install dependencies
- `npm run build` — bundle TypeScript sources into `dist/` via esbuild
- `npm run watch` — rebuild on file changes
- `npm run typecheck` — run `tsc --noEmit` for type checking

## Loading the Extension

1. Run `npm run build`
2. Open `chrome://extensions`, enable Developer Mode
3. Click "Load unpacked" and select the project root (the folder containing `manifest.json`)
