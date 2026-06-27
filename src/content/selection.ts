import { isGibberish } from "../shared/validation";

export function isPartialWordSelection(selection: Selection): boolean {
  // PDF.js text layers split text into individual spans, so word boundaries
  // often fall at span edges — the adjacent-character check falsely rejects
  // valid full-word selections. Skip the check entirely on the PDF viewer.
  if (location.pathname.includes("pdfjs/web/viewer.html")) return false;

  if (selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  let { startContainer, startOffset, endContainer, endOffset } = range;

  // Skip leading whitespace so "  genus" doesn't check before the spaces
  if (startContainer instanceof Text) {
    while (startOffset < startContainer.data.length && /\s/.test(startContainer.data[startOffset])) {
      startOffset++;
    }
  }

  // Skip trailing whitespace so "genus  " doesn't check after the spaces
  if (endContainer instanceof Text) {
    while (endOffset > 0 && /\s/.test(endContainer.data[endOffset - 1])) {
      endOffset--;
    }
  }

  if (startContainer instanceof Text && startOffset > 0) {
    if (/\p{L}/u.test(startContainer.data[startOffset - 1])) return true;
  }
  if (endContainer instanceof Text && endOffset < endContainer.data.length) {
    if (/\p{L}/u.test(endContainer.data[endOffset])) return true;
  }
  return false;
}

export function isValidSelection(selectedText: string): boolean {
  const words = selectedText.split(/\s+/);
  if (words.length > 5) return false;
  if (words.length === 1) {
    if (!/^\p{L}[\p{L}'\-]*$/u.test(selectedText)) return false;
    if (isGibberish(selectedText)) return false;
  }
  if (words.length > 1) {
    if (!words.every(w => /^\p{L}[\p{L}'\-]*$/u.test(w) && !isGibberish(w))) return false;
  }
  if (!/\p{L}/u.test(selectedText)) return false;
  return true;
}
