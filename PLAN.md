# Plan: Fix space-trimming, cap phrase length, and add root word fallback

**Goal:** Selecting "genus " (with spaces) defines correctly, phrases over 5 words are rejected, and inflected words like "Hamiltonians" fall back to their root form when lookups fail.
**Constraint source:** CLAUDE.md reviewed ✓
**Prior plan:** replaced (nested definitions plan, fully completed)
**Created:** 2026-03-02

---

## Step 1: Trim the selection range before checking partial-word boundaries

**What:** In `isPartialWordSelection`, trim leading/trailing whitespace from the selection range before checking adjacent characters. Specifically, advance `startOffset` past any whitespace and retreat `endOffset` past any whitespace, so that selecting "genus " doesn't see the next word's letter at the boundary and falsely reject the selection.
**Files:** `src/content.ts` (lines 33-44)
**Verify:** `npm run typecheck` passes. Selecting "genus " (with trailing space) no longer gets rejected by the partial-word check.

## Step 2: Add a max word count cap of 5 to `classify` in background

**What:** In the `classify` function, after splitting on whitespace, reject selections with more than 5 words by returning `"invalid"`.
**Why:** Without a cap, selecting a full paragraph would trigger API lookups.
**Files:** `src/background.ts` (lines 12-31)
**Verify:** `npm run typecheck` passes. A 6+ word selection returns `"invalid"` from `classify`.

## Step 3: Add a `getStem` function to strip common English suffixes

**What:** Create a `getStem(word: string): string | null` function in `src/background.ts` that attempts to produce a root form by stripping common inflectional suffixes in order of specificity: `-ians` -> `-ian`, `-ies` -> `-y`, `-ves` -> `-f`, `-es` -> `""`, `-s` -> `""`, `-ing` (handle doubling: `running` -> `run`, `making` -> `make`), `-ed` (handle doubling: `stopped` -> `stop`, `baked` -> `bake`), `-ly`, `-ness`, `-ment`, `-tion`/`-sion`. Return `null` if the word is too short after stripping or unchanged.
**Why:** A simple suffix-stripping approach avoids adding an NLP dependency while covering the most common inflections (plurals, verb forms, adverbs).
**Files:** `src/background.ts`
**Verify:** `npm run typecheck` passes. `getStem("Hamiltonians")` returns `"Hamiltonian"`, `getStem("running")` returns `"run"`.

## Step 4: Integrate root word fallback into `handleDefine`

**What:** In `handleDefine`, after the parallel dictionary+wikipedia lookups return zero results and before the AI fallback, call `getStem` on the selected text. If a stem is produced, retry `lookupDictionary` and `lookupWikipedia` in parallel with the stem. Merge any results into the definitions array. Only fall through to AI if both the original and stemmed lookups failed.
**Files:** `src/background.ts` (`handleDefine` function, lines 194-238)
**Verify:** `npm run typecheck` passes. Selecting "Hamiltonians" finds results for "Hamiltonian" from dictionary/wikipedia before reaching AI fallback.

## Step 5: Build and verify

**What:** Run `npm run build` to bundle the changes into `dist/`.
**Verify:** Build succeeds with no errors.

---

## Out of Scope
- Full lemmatization / NLP library
- Changing the gibberish detection heuristic
- Modifying exact mode behavior
- Showing "(root: Hamiltonian)" in the popup UI
