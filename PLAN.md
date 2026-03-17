# Plan: Fix PDF text selection misalignment

**Goal:** Eliminate the slight offset between the visible PDF text and the selectable text layer overlay, so selections highlight exactly the right characters.
**Constraint source:** CLAUDE.md reviewed ✓
**Prior plan:** continued (PDF viewer, verbosity, disambiguation plans kept below)
**Created:** 2026-03-09

---

## Root Cause

`Math.ceil()` is applied to **CSS and container dimensions** in `renderPage()`, `initViewer()`, and `rerender()`, but the pdf.js TextLayer positions its spans based on the **exact** viewport dimensions passed to the `TextLayer` constructor.

Example: if `viewport.width = 612.4`:
- Container CSS width: `Math.ceil(612.4)` = `613px`
- Canvas CSS width: `613px`
- TextLayer span positions: computed for `612.4px`-wide area

The text layer has `position: absolute; inset: 0` — it fills the 613px container. But its spans are positioned for 612.4px. Meanwhile the canvas content (rendered for 612.4px) gets stretched by the browser to fill the 613px CSS box. The canvas stretches uniformly; the text layer spans don't. Result: text selection drifts progressively rightward/downward across the page.

**Fix:** Only `Math.ceil()` the canvas **internal buffer** (`.width`/`.height` attributes, which must be integers). Use exact `viewport.width`/`viewport.height` for all CSS dimensions (container + canvas `style.width/height`). Placeholders in `initViewer()` and `rerender()` should also use exact viewport dimensions for consistency.

---

## Step 1: Remove `Math.ceil()` from CSS dimensions in `renderPage()`, `initViewer()`, and `rerender()`

**What:** In `src/pdfjs/viewer.js`:
- `renderPage()`: Change container and canvas `style.width`/`style.height` from `Math.ceil(viewport.width) + "px"` back to `viewport.width + "px"` (and same for height). Keep `Math.ceil()` only on `canvas.width` and `canvas.height` (the internal buffer).
- `initViewer()`: Change placeholder `container.style.width`/`height` from `Math.ceil(defaultViewport.width)` to `defaultViewport.width`.
- `rerender()`: Same change for the placeholder resizing loop.
**Files:** `src/pdfjs/viewer.js`
**Verify:** `npm run build` succeeds. Open a PDF — text selection should align precisely with rendered glyphs. No blur regression (canvas buffer still uses `Math.ceil`).

---

## Out of Scope
- Text selection across pdf.js span boundaries (pdf.js limitation, not our code)
- Highlighting currently selected TOC entry on scroll

---
---

# Plan: Enable Synon popup in PDF viewer

**Goal:** Make the Synon definition popup work when selecting text in the PDF viewer, so users can look up words directly from PDFs.
**Constraint source:** CLAUDE.md reviewed ✓
**Prior plan:** continued (verbosity + disambiguation plans kept below)
**Created:** 2026-03-09

---

## Step 1: Load the content script in the PDF viewer page

**What:** Add `<script src="../../dist/content.js"></script>` to `src/pdfjs/viewer.html`. The content script's `<all_urls>` manifest pattern doesn't match `chrome-extension://` URLs, so it never runs on the viewer. Loading it via script tag solves this — `chrome.runtime` and `chrome.storage` are natively available on extension pages, so all APIs work.
**Files:** `src/pdfjs/viewer.html`
**Verify:** After `npm run build`, open a PDF in the viewer. Select a word — the Synon popup should appear.

## Step 2: Disable partial-word detection for PDF text layers

**What:** In `isPartialWordSelection` (or at the call site in `index.ts`), skip the partial-word check when on the PDF viewer page. PDF.js renders text as individual `<span>` elements in the text layer, so word boundaries often fall at span edges where the adjacent character check fails incorrectly (reporting valid full-word selections as partial).
**Why:** Without this, many valid word selections in PDFs would be silently rejected.
**Files:** `src/content/selection.ts` or `src/content/index.ts`
**Verify:** Selecting a single word in the PDF text layer consistently shows the popup (not silently dropped).

## Step 3: Build and verify

**What:** Run `npm run typecheck` and `npm run build`.
**Verify:** Both pass. Selecting text in the PDF viewer shows the Synon popup with definitions.

---

## Key Design Decisions
- **Script tag over programmatic injection:** Simpler than `chrome.scripting.executeScript` from background. The viewer is our own page, so adding a script tag is clean and reliable.
- **PDF context already handled:** `context.ts` has `isPDFPage()` and `getPDFContext()` that grab text from the current + adjacent pages. No changes needed there.
- **PDF embed detection guard preserved:** The `checkForPdfEmbed()` guard already skips when `location.pathname.includes("pdfjs/web/viewer.html")`, so no redirect loop.

## Out of Scope
- Improving PDF text layer context quality for AI definitions
- Handling PDF text that spans across broken spans (ligatures, font changes)

---
---

# Plan: Add Wikipedia verbosity slider to toolbar

**Goal:** Add a slider to the extension popup that controls how much Wikipedia text is shown — from a couple sentences (low) to full paragraphs (high).
**Constraint source:** CLAUDE.md reviewed ✓
**Prior plan:** continued (disambiguation plan kept below)
**Created:** 2026-03-08

---

## Step 1: Add verbosity slider UI to popup.html

**What:** Add a labeled range slider (`<input type="range" min="1" max="5" value="3">`) below the Exact Mode toggle. Show a label like "Brief" / "Standard" / "Detailed" that updates as the slider moves.
**Files:** `src/popup/popup.html`
**Verify:** Opening the extension popup shows the slider with correct styling.

## Step 2: Wire slider to chrome.storage in popup.ts

**What:** Load `verbosity` from `chrome.storage.sync` on popup open (default `3`). Save on `input` event. Update the descriptive label text as the slider moves.
**Files:** `src/popup/popup.ts`
**Verify:** Moving the slider persists the value across popup reopens.

## Step 3: Pass verbosity to background in content script messages

**What:** In `src/content/index.ts`, read `verbosity` from `chrome.storage.sync` alongside `exactMode` when sending `MSG_DEFINE` messages. Pass it in the message payload.
**Files:** `src/content/index.ts`
**Verify:** `npm run typecheck` passes.

## Step 4: Truncate Wikipedia text by verbosity in background.ts

**What:** Add a `truncateByVerbosity(text: string, verbosity: number): string` function. Split text into sentences (split on `. ` followed by uppercase or end-of-string). Map verbosity 1-5 to sentence counts: 1→1 sentence, 2→2, 3→3, 4→5, 5→full text (no truncation). Apply this to all Wikipedia definition text in `handleDefine` before pushing to the `definitions` array. Dictionary and AI definitions are unaffected.
**Files:** `src/background.ts`
**Verify:** `npm run typecheck` passes. A Wikipedia lookup with verbosity=1 returns only the first sentence.

## Step 5: Include verbosity in cache key

**What:** Update `getCacheKey` to include verbosity, so changing verbosity doesn't serve stale truncated text from cache.
**Files:** `src/background.ts`
**Verify:** Changing verbosity and re-selecting the same word returns differently truncated text.

## Step 6: Build and verify

**What:** Run `npm run typecheck` and `npm run build`.
**Verify:** Both pass. Slider appears in popup, changing it affects Wikipedia definition length.

---

## Key Design Decisions
- **Verbosity only affects Wikipedia:** Dictionary definitions are already concise. AI definitions have their own token limit. Only Wikipedia extracts are long enough to benefit from truncation.
- **Sentence-based truncation:** More natural than character-based. Wikipedia extracts are well-formed prose with clear sentence boundaries.
- **Range 1-5:** Provides enough granularity without being overwhelming. Default 3 (3 sentences) is a good middle ground.
- **Truncation in background, not UI:** Keeps the popup rendering simple and avoids sending excess data over message passing.

## Out of Scope
- Verbosity for AI definitions (already controlled by max_tokens)
- Verbosity for Dictionary definitions (already concise)
- Per-word verbosity override

---
---

# Plan: Add Wikipedia disambiguation support

**Goal:** When a Wikipedia lookup returns a disambiguation page, fetch the top disambiguation entries and add each as a separate definition page the user can navigate with the existing prev/next arrows.
**Constraint source:** CLAUDE.md reviewed ✓
**Prior plan:** replaced (space-trimming/stemming plan, fully completed)
**Created:** 2026-03-08

---

## Step 1: Replace `lookupWikipedia` with disambiguation-aware version

**What:** Modify `lookupWikipedia` in `src/background.ts` to return an array instead of a single result. When the REST summary API returns `type: "disambiguation"`:
1. Fetch the intro section wikitext via `https://en.wikipedia.org/w/api.php?action=parse&page={title}&prop=wikitext&section=0&format=json`
2. Parse `[[Article Title]]` or `[[Article Title|display]]` links from the wikitext using regex
3. For each linked article (cap at ~5 to avoid excessive requests), fetch its summary via the REST summary API in parallel
4. Return all successful summaries as separate results

When it's a normal (non-disambiguation) page, return a single-element array as before.

**Why:** The intro section (section 0) contains the "most commonly refers to" entries, which are the most relevant meanings. Capping at 5 keeps request count reasonable.
**Files:** `src/background.ts`
**Verify:** `npm run typecheck` passes. The function signature changes from returning a single result to an array.

## Step 2: Update `handleDefine` to handle multiple Wikipedia results

**What:** Update the call sites in `handleDefine` that consume `lookupWikipedia`'s return value. Since it now returns an array, push each result as a separate `Definition` with `source: "Wikipedia"`. Apply the same change for the lemma fallback path.
**Files:** `src/background.ts`
**Verify:** `npm run typecheck` passes. Looking up "Mercury" returns multiple Wikipedia definitions (planet, element, mythology) alongside any dictionary result.

## Step 3: Build and verify

**What:** Run `npm run build` to bundle changes into `dist/`.
**Verify:** Build succeeds with no errors.

---

## Key Design Decisions
- **Section 0 only vs all sections:** Section 0 contains the primary/most common meanings. Fetching all 115 links (like Mercury has) would be overwhelming. Section 0 typically has 2-5 entries.
- **Fallback when section 0 is empty:** Some disambiguation pages (like "Crane") have no links in section 0 — all entries are in sub-sections. In this case, fall back to fetching sections 1-3 wikitext and extracting their links instead.
- **Cap at 5 entries:** Prevents excessive parallel API calls while still covering the main meanings.
- **No UI changes needed:** The existing prev/next navigation arrows and `n / total` label in `popup-state.ts` already handle multiple definitions seamlessly.

## Out of Scope
- Letting users browse all 100+ disambiguation entries (only top entries shown)
- Adding a "disambiguation" label/badge to the popup UI
- Changing the definition pipeline order (dictionary → wikipedia → AI)
