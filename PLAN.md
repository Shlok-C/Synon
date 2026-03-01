# Plan: Show "Hello World" Popup on Text Selection

## Goal

Add an inline tooltip-style popup that appears near selected text showing "Hello World" — the first step toward showing real definitions in-page.

## Steps

1. **Create `PLAN.md`** — this file
2. **Rewrite `src/content.ts`** — add `showPopup()` and `removePopup()` functions, render a floating div near the selection on `mouseup`, dismiss on `mousedown`

## Files Modified

| File | Action |
|---|---|
| `PLAN.md` | Created |
| `src/content.ts` | Rewritten |

## Verification

1. `npm run typecheck` — no type errors
2. `npm run build` — builds successfully
3. Load extension in Chrome, select text → "Hello World" tooltip appears
4. Click elsewhere → tooltip disappears
