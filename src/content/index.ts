import type { Definition, DefineResponse } from "../shared/types";
import { MSG_DEFINE, MSG_SHOW_DEFINITION, MSG_PDF_DETECTED, type DefineMessage } from "../shared/messages";
import { getPageContext, getPageKind } from "./context";
import { createPositionTracker } from "./positioning";
import { isPartialWordSelection, isValidSelection, isEditableContext } from "./selection";
import { normalizeSelection } from "../shared/validation";
import { buildPopupDOM } from "./popup-ui";
import { createPopupStateManager, type PopupStateManager } from "./popup-state";

function sendMessageWithTimeout(
  message: unknown,
  timeoutMs: number = 20000
): Promise<DefineResponse | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    chrome.runtime.sendMessage(message, (response: DefineResponse) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

const HOST_ID = "synon-popup-host";
let currentHost: HTMLDivElement | null = null;
let dismissedByClose = false;

const positionTracker = createPositionTracker();
let stateManager: PopupStateManager | null = null;
let lastButtonActionTime = 0;
let lastHandledSelection: { text: string; time: number } = { text: "", time: 0 };
let lastEditTime = 0;
let popupOpenedAt = 0;

// Track edits (typed or deleted characters) in any editable surface. This is the
// "user is actively typing" signal; it also dismisses an open popup the instant
// the user resumes editing (e.g. selecting a word then pressing Backspace).
document.addEventListener("input", () => {
  lastEditTime = Date.now();
  if (currentHost) removePopup();
}, true);

function removePopup(): void {
  positionTracker.detach();
  if (currentHost) {
    currentHost.remove();
    currentHost = null;
  }
  stateManager?.reset();
  stateManager = null;
}

function getSettings(): Promise<{ exactMode: boolean; verbosity: number; quietMode: boolean }> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["exactMode", "verbosity", "quietMode"], (result) => {
      resolve({
        exactMode: result.exactMode === true,
        verbosity: result.verbosity ?? 3,
        quietMode: result.quietMode !== false,
      });
    });
  });
}

// Shared interpretation of a DefineResponse for both the top-level and nested flows.
function applyDefineResponse(
  response: DefineResponse | null,
  opts: { hostAtRequest: HTMLDivElement | null; quietMode: boolean; onSkip: () => void }
): void {
  const { hostAtRequest, quietMode, onSkip } = opts;
  if (currentHost !== hostAtRequest) return;

  if (!response) {
    if (quietMode) { removePopup(); return; }
    stateManager?.setDefinitions([], "Definition timed out. Please try again.");
    return;
  }

  if (response.skip) { onSkip(); return; }

  // Debug-inspect: expose the per-highlight schema for development.
  if (response.schema) {
    console.debug("[Synon] schema", response.schema);
    if (currentHost) currentHost.dataset.synonSchema = JSON.stringify(response.schema);
    stateManager?.setSchema(response.schema);
  }

  if (response.error) {
    if (quietMode && (!response.definitions || response.definitions.length === 0)) {
      removePopup();
      return;
    }
    stateManager?.setDefinitions(response.definitions || [], quietMode ? undefined : response.error);
  } else if (response.definitions?.length) {
    stateManager?.setDefinitions(response.definitions);
  } else {
    if (quietMode) { removePopup(); return; }
    stateManager?.setDefinitions([], "No response received. Try again.");
  }
}

function showPopup(range: Range, selectedText: string): void {
  removePopup();

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });

  const elements = buildPopupDOM(shadow, selectedText, {
    onClose() {
      lastButtonActionTime = Date.now();
      dismissedByClose = true;
      removePopup();
    },
    onBack() {
      lastButtonActionTime = Date.now();
      stateManager?.popStack();
    },
    onPrev() {
      lastButtonActionTime = Date.now();
      stateManager?.navigatePrev();
    },
    onNext() {
      lastButtonActionTime = Date.now();
      stateManager?.navigateNext();
    },
  });

  stateManager = createPopupStateManager(elements);

  const rect = range.getBoundingClientRect();
  const { left, top } = positionTracker.computeInitialPosition(rect);
  elements.card.style.left = `${left}px`;
  elements.card.style.top = `${top}px`;

  document.body.appendChild(host);
  currentHost = host;
  popupOpenedAt = Date.now();
  positionTracker.attach(elements.card, range);

  // Listen for text selection inside the popup (nested definitions)
  shadow.addEventListener("mouseup", (e: Event) => {
    e.stopPropagation();

    // Skip if a button was just clicked
    if (Date.now() - lastButtonActionTime < 100) return;

    // Don't process selection when clicking interactive elements
    const target = e.target as HTMLElement;
    if (target.closest?.("button")) return;

    const sel = "getSelection" in shadow
      ? (shadow as any).getSelection() as Selection | null
      : document.getSelection();
    if (!sel || sel.isCollapsed) return;

    // Only process selections originating inside the shadow DOM
    if (sel.anchorNode && !shadow.contains(sel.anchorNode)) return;

    const text = normalizeSelection(sel.toString().trim());
    if (!text) return;

    if (stateManager?.currentState && text === stateManager.currentState.word) return;

    stateManager?.pushAndLoad(text);

    const hostAtRequest = currentHost;
    void (async () => {
      const { exactMode, verbosity, quietMode } = await getSettings();
      const message: DefineMessage = {
        type: MSG_DEFINE, selectedText: text, pageContext: "", exactMode, verbosity, pageKind: getPageKind(),
      };
      const response = await sendMessageWithTimeout(message);
      applyDefineResponse(response, {
        hostAtRequest,
        quietMode,
        onSkip: () => {
          if (stateManager && stateManager.stackLength > 0) stateManager.popStack();
          else removePopup();
        },
      });
    })();

    // Protect this deliberate clear from the deselect-dismissal in selectionchange.
    lastButtonActionTime = Date.now();
    sel.removeAllRanges();
  });
}

// Dismiss on click outside
document.addEventListener("mousedown", (e: MouseEvent) => {
  if (!currentHost) return;
  if (Date.now() - lastButtonActionTime < 100) return;
  if (e.target === currentHost || e.composedPath().includes(currentHost)) return;
  removePopup();
});

// Keyboard control: Escape dismisses (superseding the page); Left/Right cycle meanings.
// Capture-phase on window so the popup consumes the key before the page's own handlers.
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (!currentHost) return; // no popup → let the page handle Escape/arrows normally

  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    removePopup();
    return;
  }

  // Don't hijack arrows while the user is in a form field / editor.
  const ae = document.activeElement as HTMLElement | null;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;

  const state = stateManager?.currentState;
  if (!state || state.definitions.length <= 1) return;

  if (e.key === "ArrowLeft") { e.preventDefault(); e.stopImmediatePropagation(); stateManager!.navigatePrev(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); e.stopImmediatePropagation(); stateManager!.navigateNext(); }
}, true);

// Handle context-menu definitions from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== MSG_SHOW_DEFINITION) return;

  const { selectedText, definitions, error } = message as {
    selectedText: string;
    definitions: Definition[];
    error?: string;
  };

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  const range = selection.getRangeAt(0).cloneRange();
  showPopup(range, selectedText);
  stateManager?.setLoadingState(selectedText);

  if (error && (!definitions || definitions.length === 0)) {
    stateManager?.setDefinitions([], error);
  } else if (definitions?.length) {
    stateManager?.setDefinitions(definitions);
  } else {
    stateManager?.setDefinitions([], "Something went wrong.");
  }
});

// Core selection handler — shared by mouse, touch, and keyboard selection
function handleSelection(): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    dismissedByClose = false;
    return;
  }

  const selectedText = normalizeSelection(selection.toString().trim());
  if (!selectedText) {
    dismissedByClose = false;
    return;
  }

  if (dismissedByClose) return;

  // Deduplicate: if the same text was just handled and popup is still showing, skip
  if (
    currentHost &&
    selectedText === lastHandledSelection.text &&
    Date.now() - lastHandledSelection.time < 500
  ) return;

  if (isPartialWordSelection(selection)) return;

  if (!isValidSelection(selectedText)) return;

  // Don't define while editing: suppress in an editable surface if the user typed recently.
  const TYPING_IDLE_MS = 1500;
  if (isEditableContext(selection) && Date.now() - lastEditTime < TYPING_IDLE_MS) return;

  const range = selection.getRangeAt(0).cloneRange();

  showPopup(range, selectedText);
  stateManager?.setLoadingState(selectedText);
  lastHandledSelection = { text: selectedText, time: Date.now() };
  const hostAtCreation = currentHost;

  const pageContext = getPageContext(selection);

  void (async () => {
    const { exactMode, verbosity, quietMode } = await getSettings();
    const message: DefineMessage = {
      type: MSG_DEFINE, selectedText, pageContext, exactMode, verbosity, pageKind: getPageKind(),
    };
    const response = await sendMessageWithTimeout(message);
    applyDefineResponse(response, {
      hostAtRequest: hostAtCreation,
      quietMode,
      onSkip: () => removePopup(),
    });
  })();
}

// Show popup on mouse text selection
document.addEventListener("mouseup", (e: MouseEvent) => {
  if (Date.now() - lastButtonActionTime < 100) return;
  if (currentHost && (e.target === currentHost || e.composedPath().includes(currentHost))) return;
  // Cancel pending selectionchange timer — mouseup handles it immediately
  if (selectionChangeTimer) { clearTimeout(selectionChangeTimer); selectionChangeTimer = null; }
  handleSelection();
});

// Show popup on touch text selection
document.addEventListener("touchend", () => {
  if (Date.now() - lastButtonActionTime < 100) return;
  // Cancel pending selectionchange timer — touchend handles it immediately
  if (selectionChangeTimer) { clearTimeout(selectionChangeTimer); selectionChangeTimer = null; }
  handleSelection();
});

// Dismiss the popup the instant the selection that spawned it is gone.
function maybeDismissOnDeselect(): void {
  if (!currentHost) return;
  // Protect the open moment and any just-happened popup interaction (incl. the
  // deliberate removeAllRanges() in the nested-definition flow).
  if (Date.now() - popupOpenedAt < 400) return;
  if (Date.now() - lastButtonActionTime < 400) return;
  // User is selecting text inside the popup itself (nested flow) — keep it.
  const sh = currentHost.shadowRoot;
  const shadowSel = sh && "getSelection" in sh ? (sh as any).getSelection() as Selection | null : null;
  if (shadowSel && !shadowSel.isCollapsed && shadowSel.toString().trim()) return;
  // A real page selection still exists — keep it.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim()) return;
  removePopup();
}

// Show popup on keyboard text selection (Shift+arrow, Ctrl+A, etc.)
let selectionChangeTimer: ReturnType<typeof setTimeout> | null = null;
document.addEventListener("selectionchange", () => {
  maybeDismissOnDeselect();
  if (selectionChangeTimer) clearTimeout(selectionChangeTimer);
  selectionChangeTimer = setTimeout(() => {
    selectionChangeTimer = null;
    handleSelection();
  }, 300);
});

// --- PDF embed detection ---
function checkForPdfEmbed(): void {
  if (location.pathname.includes("pdfjs/web/viewer.html")) return;
  chrome.storage.sync.get("pdfViewerEnabled", (result) => {
    if (result.pdfViewerEnabled === false) return;
    const embed = document.querySelector('embed[type="application/pdf"]');
    if (embed) {
      chrome.runtime.sendMessage({ type: MSG_PDF_DETECTED, url: location.href });
    }
  });
}
checkForPdfEmbed();
