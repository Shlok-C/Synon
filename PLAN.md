# Plan: Nested Definitions + Multiple Definitions

**Goal:** Selecting text inside the popup replaces it with a new definition (with back navigation), and words with multiple sources show left/right arrows to page through them.

**Constraint source:** CLAUDE.md reviewed ✓
**Prior plan:** replaced (definition pipeline plan, fully completed)
**Created:** 2026-03-01

---

## Step 1: Background returns multiple definitions [DONE]

**What:** Change `handleDefine` to run Dictionary + Wikipedia lookups in parallel via `Promise.all`, collecting all successful results into a `{ source, text }[]` array. Fall back to AI only if both free sources fail. Response shape changes from `{ definition }` to `{ definitions[] }`.
**Files:** `src/background.ts`
**Verify:** `npm run typecheck` passes. Common words return 2 definitions (dictionary + wikipedia).

## Step 2: Content script handles multi-definition responses [DONE]

**What:** Update mouseup listener and SHOW_DEFINITION handler to accept a definitions array. Store definitions + current index on popup state. Build a footer with `‹`/`›` arrows and `1 / 3` label positioned bottom-right. Footer only visible when `definitions.length > 1`.
**Files:** `src/content.ts`
**Verify:** `npm run typecheck` passes. Selecting "run" shows nav arrows to cycle through dictionary + wikipedia definitions.

## Step 3: Nested definitions via in-popup text selection [DONE]

**What:** Maintain a stack of popup states (`{ word, definitions, index }[]`). Listen for mouseup on the shadow root — when text is selected inside the popup body, push current state onto stack, show loading, send new DEFINE message. Show a `←` back button in top-left of header (hidden when stack is empty). Back pops stack and restores previous state. Close (`×`) dismisses entire popup and clears stack.
**Files:** `src/content.ts`
**Verify:** `npm run typecheck` passes. Selecting text inside popup replaces content with new definition, back arrow appears, clicking it restores previous.

## Step 4: Add styles for new elements [DONE]

**What:** Add CSS for `.synon-back` (top-left, same style as close), `.synon-footer` (flex row, justify-content: flex-end), `.synon-nav-btn` (small arrow buttons), `.synon-nav-label` (counter text, subtle color).
**Files:** `src/content.ts` (inside `buildShadowStyles`)
**Verify:** `npm run build` succeeds. Popup layout matches the ASCII mockup from the design.

---

## Out of Scope
- Caching definitions locally
- Showing the definition source label (e.g. "Dictionary", "Wikipedia") in the UI
- Animating transitions between nested definitions
