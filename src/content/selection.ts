import { isViewerPathname } from "../shared/pdf-viewer-url";

export function isPartialWordSelection(selection: Selection): boolean {
  // PDF.js text layers split text into individual spans, so word boundaries
  // often fall at span edges — the adjacent-character check falsely rejects
  // valid full-word selections. Skip the check entirely on the PDF viewer.
  if (isViewerPathname(location.pathname)) return false;

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

// True for a form field or contenteditable surface. isContentEditable already
// accounts for inherited contenteditable ancestors.
export function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

// True if the selection sits inside an editable surface (rich-text editor, email
// compose box, contenteditable region, or a focused input/textarea). Used to
// suppress definitions while the user is editing rather than reading.
export function isEditableContext(selection: Selection): boolean {
  const node = selection.focusNode ?? selection.anchorNode;
  if (node) {
    const el = node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
    if (isEditableElement(el)) return true;
  }
  if (document.designMode === "on") return true;
  if (isEditableElement(document.activeElement)) return true;
  return false;
}
