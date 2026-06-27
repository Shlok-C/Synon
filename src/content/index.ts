import type { Definition, DefineResponse } from "../shared/types";
import { MSG_DEFINE, MSG_SHOW_DEFINITION, MSG_PDF_DETECTED } from "../shared/messages";
import { getPageContext } from "./context";
import { createPositionTracker } from "./positioning";
import { isPartialWordSelection, isValidSelection } from "./selection";
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

function removePopup(): void {
  positionTracker.detach();
  if (currentHost) {
    currentHost.remove();
    currentHost = null;
  }
  stateManager?.reset();
  stateManager = null;
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
    chrome.storage.sync.get(["exactMode", "verbosity", "quietMode"], async (result) => {
      const exactMode = result.exactMode === true;
      const verbosity = result.verbosity ?? 3;
      const quietMode = result.quietMode !== false;
      const response = await sendMessageWithTimeout(
        { type: MSG_DEFINE, selectedText: text, pageContext: "", exactMode, verbosity }
      );
      if (currentHost !== hostAtRequest) return;
      if (!response) {
        if (quietMode) { removePopup(); return; }
        stateManager?.setDefinitions([], "Definition timed out. Please try again.");
        return;
      }
      if (response.skip) {
        if (stateManager && stateManager.stackLength > 0) {
          stateManager.popStack();
        } else {
          removePopup();
        }
        return;
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
    });

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

// Dismiss on Escape
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    removePopup();
  }
});

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

  const range = selection.getRangeAt(0).cloneRange();

  showPopup(range, selectedText);
  stateManager?.setLoadingState(selectedText);
  lastHandledSelection = { text: selectedText, time: Date.now() };
  const hostAtCreation = currentHost;

  const pageContext = getPageContext(selection);

  chrome.storage.sync.get(["exactMode", "verbosity", "quietMode"], async (result) => {
    const exactMode = result.exactMode === true;
    const verbosity = result.verbosity ?? 3;
    const quietMode = result.quietMode !== false;
    const response = await sendMessageWithTimeout(
      { type: MSG_DEFINE, selectedText, pageContext, exactMode, verbosity }
    );
    if (currentHost !== hostAtCreation) return;

    if (!response) {
      if (quietMode) { removePopup(); return; }
      stateManager?.setDefinitions([], "Definition timed out. Please try again.");
      return;
    }

    if (response.skip) {
      removePopup();
      return;
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
  });
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

// Show popup on keyboard text selection (Shift+arrow, Ctrl+A, etc.)
let selectionChangeTimer: ReturnType<typeof setTimeout> | null = null;
document.addEventListener("selectionchange", () => {
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
