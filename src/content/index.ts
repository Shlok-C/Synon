import type { Definition, DefineResponse, SelectionType } from "../shared/types";
import {
  MSG_DEFINE,
  MSG_DEFINE_PARTIAL,
  MSG_DEFINE_RESULT,
  MSG_SHOW_DEFINITION,
  MSG_PDF_DETECTED,
  MSG_GET_ARTICLE_SNAPSHOT,
  MSG_SWITCH_TAB,
  MSG_WARMUP,
  DEFINE_PORT_NAME,
  type DefineMessage,
  type DefinePartialMessage,
  type DefineResultMessage,
  type ShowDefinitionMessage,
  type PDFDetectedMessage,
  type SwitchTabMessage,
  type WarmupMessage,
} from "../shared/messages";
import { getPageContext, getPageKind, extractArticleSnapshot } from "./context";
import { createPositionTracker } from "./positioning";
import { isPartialWordSelection, isEditableContext, isEditableElement } from "./selection";
import { normalizeSelection, classify } from "../shared/validation";
import { isViewerPathname, getViewerUrl } from "../shared/pdf-viewer-url";
import { storageGet } from "../shared/storage";
import { isCommonWord } from "../common-words";
import { buildPopupDOM } from "./popup-ui";
import { createPopupStateManager, type PopupStateManager } from "./popup-state";

// Mirrors background.ts's "common" computation (word: itself; phrase: any word
// common) so the Exact-Mode-off skip gate can be checked client-side, before
// ever showing the popup — see the exactMode cache below for why.
function isCommonSelection(text: string, type: SelectionType): boolean {
  if (type === "word") return isCommonWord(text);
  return text.trim().split(/\s+/).some((w) => isCommonWord(w));
}

// In-memory copy of the define-related settings, read synchronously:
// - exactMode lets handleSelection run the common-word skip gate before
//   showPopup() — otherwise the popup flashes open (loading state) and is torn
//   down once the background's own gate reports skip:true a moment later;
// - all three let a define request go out without first awaiting a storage read.
// Loaded at startup and kept current via storage.onChanged.
interface DefineSettings {
  exactMode: boolean;
  verbosity: number;
  quietMode: boolean;
}

function toDefineSettings(raw: { exactMode?: unknown; verbosity?: unknown; quietMode?: unknown }): DefineSettings {
  return {
    exactMode: raw.exactMode === true,
    verbosity: typeof raw.verbosity === "number" ? raw.verbosity : 3,
    quietMode: raw.quietMode !== false,
  };
}

let cachedSettings: DefineSettings = toDefineSettings({});
void storageGet<{ exactMode?: boolean; verbosity?: number; quietMode?: boolean }>(
  "sync",
  ["exactMode", "verbosity", "quietMode"]
).then((r) => { cachedSettings = toDefineSettings(r); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  const next = { ...cachedSettings };
  for (const key of ["exactMode", "verbosity", "quietMode"] as const) {
    if (key in changes) (next as Record<string, unknown>)[key] = changes[key].newValue;
  }
  cachedSettings = toDefineSettings(next);
});

// Must stay above the background's DEFINE_BUDGET_MS (20s, background/define.ts)
// so a define request always gets the background's real answer, not this fallback.
const DEFINE_TIMEOUT_MS = 25000;

// Runs a define request over a port (see DEFINE_PORT_NAME): `onPartial` gets
// each interim definition list; resolves with the final response, or null on
// timeout / a dropped connection (e.g. the extension was reloaded).
function requestDefinition(
  message: DefineMessage,
  onPartial: (definitions: Definition[]) => void
): Promise<DefineResponse | null> {
  return new Promise((resolve) => {
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: DEFINE_PORT_NAME });
    } catch {
      resolve(null); // extension context invalidated
      return;
    }
    let done = false;
    const finish = (response: DefineResponse | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch { /* already closed */ }
      resolve(response);
    };
    const timer = setTimeout(() => finish(null), DEFINE_TIMEOUT_MS);
    port.onMessage.addListener((msg: DefinePartialMessage | DefineResultMessage) => {
      if (msg.type === MSG_DEFINE_PARTIAL) { if (!done) onPartial(msg.definitions); }
      else if (msg.type === MSG_DEFINE_RESULT) finish(msg.response);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // consumed so Chrome doesn't log it as unchecked
      finish(null);
    });
    port.postMessage(message);
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
// Set once the user presses the mouse inside the popup. Pressing there collapses
// the page selection the popup was opened from, so an engaged popup is exempt
// from deselect-dismissal (maybeDismissOnDeselect) — otherwise the first click of
// a double-click, or the start of a drag, would destroy the popup before any
// nested word could be selected. It still closes via click-outside/Escape/×/typing.
let popupEngaged = false;

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
  popupEngaged = false;
}

// In quiet mode, a failure/empty result is silently dropped via `onEmpty`;
// otherwise it's shown as an empty-definitions state carrying the given message.
function showOrDismiss(quietMode: boolean, message: string, onEmpty: () => void): void {
  if (quietMode) { onEmpty(); return; }
  stateManager?.setDefinitions([], message);
}

// Shared interpretation of a final DefineResponse for both the top-level and nested flows.
// `onEmpty` handles a skipped/failed/empty lookup: the top-level flow closes the
// popup, the nested flow steps back one level (backOutOfNested).
function applyDefineResponse(
  response: DefineResponse | null,
  opts: { quietMode: boolean; onEmpty: () => void }
): void {
  const { quietMode, onEmpty } = opts;

  if (!response) {
    showOrDismiss(quietMode, "Definition timed out. Please try again.", onEmpty);
    return;
  }

  if (response.skip) { onEmpty(); return; }

  if (response.schema) {
    stateManager?.setSchema(response.schema);
  }

  if (response.error) {
    if (quietMode && (!response.definitions || response.definitions.length === 0)) {
      onEmpty();
      return;
    }
    stateManager?.setDefinitions(response.definitions || [], quietMode ? undefined : response.error);
  } else if (response.definitions?.length) {
    // May replace a partial already on screen — keeps the user's place if they navigated.
    stateManager?.updateDefinitions(response.definitions);
  } else {
    showOrDismiss(quietMode, "No response received. Try again.", onEmpty);
  }
}

// Sends a define request for the popup's current state. Results go to that
// state object, found by identity:
// - dropped if the popup was replaced/closed, or the state left the stack
//   (the user stepped back past it) while the request was in flight;
// - applied as data only while the state waits on the back stack (the user
//   drilled into a nested word before this one finished) — it renders with
//   the complete list when they come back;
// - applied fully (including quiet-mode dismissal/back-out) while showing.
function startDefine(selectedText: string, pageContext: string, onEmpty: () => void): void {
  const hostAtRequest = currentHost;
  const stateAtRequest = stateManager?.currentState ?? null;
  if (!stateAtRequest) return;
  const isAlive = () => currentHost === hostAtRequest && !!stateManager?.hasState(stateAtRequest);
  const isShowing = () => isAlive() && stateManager!.currentState === stateAtRequest;
  const { exactMode, verbosity, quietMode } = cachedSettings;
  const message: DefineMessage = {
    type: MSG_DEFINE, selectedText, pageContext, exactMode, verbosity, pageKind: getPageKind(),
  };
  void requestDefinition(message, (definitions) => {
    if (isAlive()) stateManager!.updateDefinitions(definitions, stateAtRequest);
  }).then((response) => {
    if (isShowing()) {
      applyDefineResponse(response, { quietMode, onEmpty });
    } else if (isAlive() && response?.definitions?.length) {
      stateManager!.updateDefinitions(response.definitions, stateAtRequest);
      if (response.schema) stateManager!.setSchema(response.schema, stateAtRequest);
    }
  });
}

// A nested lookup that comes back empty returns to the previous popup level
// instead of closing the whole stack.
function backOutOfNested(): void {
  if (stateManager && stateManager.stackLength > 0) stateManager.popStack();
  else removePopup();
}

// Nested definitions: define the text currently selected inside the popup.
// Called from the popup's own mouseup, and from the document mouseup when a
// drag that started in the popup is released outside it.
function handlePopupSelection(shadow: ShadowRoot): void {
  const sel = getShadowSelection(shadow);
  if (!sel || sel.isCollapsed) return;

  // Only process selections originating inside the shadow DOM
  if (sel.anchorNode && !shadow.contains(sel.anchorNode)) return;

  const text = normalizeSelection(sel.toString().trim());
  if (!text) return;

  if (stateManager?.currentState && text === stateManager.currentState.word) return;

  const nestedType = classify(text);
  if (nestedType === "invalid") return;
  if (!cachedSettings.exactMode && isCommonSelection(text, nestedType)) return;

  stateManager?.pushAndLoad(text);
  startDefine(text, "", backOutOfNested);

  // Protect this deliberate clear from the deselect-dismissal in selectionchange.
  lastButtonActionTime = Date.now();
  sel.removeAllRanges();
}

// Chrome exposes a non-standard ShadowRoot.getSelection(); window.getSelection()
// reports selections inside a shadow tree as collapsed.
function getShadowSelection(shadow: ShadowRoot): Selection | null {
  return "getSelection" in shadow
    ? (shadow as any).getSelection() as Selection | null
    : document.getSelection();
}

// True when a popup is open and text inside it is selected.
function hasPopupSelection(): boolean {
  const shadow = currentHost?.shadowRoot;
  if (!shadow) return false;
  const sel = getShadowSelection(shadow);
  return !!sel && !sel.isCollapsed && !!sel.anchorNode && shadow.contains(sel.anchorNode);
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

    handlePopupSelection(shadow);
  });
}

// Dismiss on click outside; a press inside the popup engages it (see popupEngaged).
document.addEventListener("mousedown", (e: MouseEvent) => {
  if (!currentHost) return;
  if (e.target === currentHost || e.composedPath().includes(currentHost)) {
    popupEngaged = true;
    // The user may be starting to select text in the definition — a progressive
    // update arriving mid-gesture must not swap it out from under them.
    stateManager?.pin();
    return;
  }
  if (Date.now() - lastButtonActionTime < 100) return;
  removePopup();
});

// Keyboard control: Ctrl+Left/Right switches tabs (outside text fields, so word-jumping
// still works there); Escape dismisses the popup (superseding the page); Left/Right
// cycle meanings. Capture-phase on window so we see the key before the page's handlers.
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (
    e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey &&
    (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
    !isEditableElement(document.activeElement)
  ) {
    e.preventDefault();
    const switchTabMessage: SwitchTabMessage = {
      type: MSG_SWITCH_TAB,
      direction: e.key === "ArrowRight" ? "next" : "prev",
    };
    chrome.runtime.sendMessage(switchTabMessage);
    return;
  }

  if (!currentHost) return; // no popup → let the page handle Escape/arrows normally

  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    removePopup();
    return;
  }

  // Don't hijack arrows while the user is in a form field / editor.
  if (isEditableElement(document.activeElement)) return;
  // Modified arrows (e.g. Ctrl+Arrow word-jumping) are never meaning navigation.
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const state = stateManager?.currentState;
  if (!state || state.definitions.length <= 1) return;

  if (e.key === "ArrowLeft") { e.preventDefault(); e.stopImmediatePropagation(); stateManager!.navigatePrev(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); e.stopImmediatePropagation(); stateManager!.navigateNext(); }
}, true);

// Handle context-menu definitions from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== MSG_SHOW_DEFINITION) return;

  const { selectedText, definitions, error } = message as ShowDefinitionMessage;

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

  const selectionType = classify(selectedText);
  if (selectionType === "invalid") return;

  // Exact Mode off: skip common words/phrases before ever showing a popup —
  // see isCommonSelection's comment for why this must happen here, not just
  // in background.ts.
  if (!cachedSettings.exactMode && isCommonSelection(selectedText, selectionType)) return;

  // Don't define while editing: suppress in an editable surface if the user typed recently.
  const TYPING_IDLE_MS = 1500;
  if (isEditableContext(selection) && Date.now() - lastEditTime < TYPING_IDLE_MS) return;

  const range = selection.getRangeAt(0).cloneRange();

  showPopup(range, selectedText);
  stateManager?.setLoadingState(selectedText);
  lastHandledSelection = { text: selectedText, time: Date.now() };
  startDefine(selectedText, getPageContext(selection), removePopup);
}

// Wake the service worker while the user is still making a selection, so its
// cold start (~0.1–0.35s to evaluate the bundled lexicon) overlaps the gesture.
// selectstart, not mousedown: only selections, not every click on every page.
const WARMUP_INTERVAL_MS = 20000; // under Chrome's ~30s idle shutdown
let lastWarmupAt = 0;
document.addEventListener("selectstart", () => {
  if (Date.now() - lastWarmupAt < WARMUP_INTERVAL_MS) return;
  lastWarmupAt = Date.now();
  const warmup: WarmupMessage = { type: MSG_WARMUP };
  try {
    chrome.runtime.sendMessage(warmup).catch(() => {});
  } catch {
    // extension context invalidated (reloaded) — nothing to warm
  }
});

// Show popup on mouse text selection
document.addEventListener("mouseup", (e: MouseEvent) => {
  if (Date.now() - lastButtonActionTime < 100) return;
  if (currentHost && (e.target === currentHost || e.composedPath().includes(currentHost))) return;
  // Cancel pending selectionchange timer — mouseup handles it immediately
  if (selectionChangeTimer) { clearTimeout(selectionChangeTimer); selectionChangeTimer = null; }
  // A drag that began inside the popup but was released outside it: the popup's
  // own mouseup never fired, and window.getSelection() reports shadow-DOM
  // selections as collapsed, so handleSelection() would ignore it.
  if (hasPopupSelection()) { handlePopupSelection(currentHost!.shadowRoot!); return; }
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
  // The user clicked into the popup, which itself collapses the page selection.
  if (popupEngaged) return;
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

// Respond with the current page's article snapshot (title, favicon, best-effort text)
// for the Library "Add to Library" flow.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== MSG_GET_ARTICLE_SNAPSHOT) return;
  sendResponse(extractArticleSnapshot());
});

// --- PDF detection / in-place embed replacement ---
// Two different situations, never conflated:
// 1. This frame's document IS a PDF (Chrome's native viewer). Top frame → ask
//    the background to redirect the tab (fallback for anything its header
//    listener missed); subframe → turn just this frame into Synon's viewer.
// 2. A normal page CONTAINS a PDF (<embed>/<object>/<iframe>). The element is
//    swapped for an iframe of Synon's viewer at the same size — the host page
//    stays put. Watched with a MutationObserver since pages often insert the
//    embed from JS after load (e.g. a CV page choosing embed vs. link).
const PDF_EMBED_SELECTOR = "embed, object, iframe";
const SYNON_PDF_ATTR = "data-synon-pdf";

function pdfUrlForElement(el: Element): string | null {
  if (el.hasAttribute(SYNON_PDF_ATTR)) return null;
  const raw = el.getAttribute(el.tagName === "OBJECT" ? "data" : "src");
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw, document.baseURI); } catch { return null; }
  // Only fetchable network URLs: a page's blob:/data: URLs aren't readable from
  // the extension's origin, and our own viewer URL must never be re-wrapped.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const declaredPdf = (el.getAttribute("type") || "").toLowerCase().startsWith("application/pdf");
  if (!declaredPdf && !url.pathname.toLowerCase().endsWith(".pdf")) return null;
  return url.href;
}

// A width/height attribute ("100%", "800", "800px") as a CSS length.
function attrToCssLength(value: string | null): string {
  if (!value) return "";
  const v = value.trim();
  return /^\d+(\.\d+)?$/.test(v) ? `${v}px` : v;
}

function replacePdfElement(el: Element, pdfUrl: string): void {
  const iframe = document.createElement("iframe");
  iframe.src = getViewerUrl(pdfUrl);
  iframe.setAttribute(SYNON_PDF_ATTR, "");
  iframe.setAttribute("allow", "fullscreen");
  iframe.title = el.getAttribute("title") || "PDF document";
  if (el.id) iframe.id = el.id;
  if (el.getAttribute("class")) iframe.setAttribute("class", el.getAttribute("class")!);
  const style = el.getAttribute("style");
  if (style) iframe.setAttribute("style", style);
  // Inline width/height wins over the element's own attributes, mirroring how
  // the original element would have been sized.
  if (!iframe.style.width) iframe.style.width = attrToCssLength(el.getAttribute("width"));
  if (!iframe.style.height) iframe.style.height = attrToCssLength(el.getAttribute("height"));
  // Without a size an embed defaults to ~300x150 — too small to read a page.
  if (!iframe.style.width) iframe.style.width = "100%";
  if (!iframe.style.height) iframe.style.height = "80vh";
  iframe.style.border = "none";
  el.replaceWith(iframe);
}

function replacePdfEmbeds(root: ParentNode): void {
  const candidates = root.querySelectorAll(PDF_EMBED_SELECTOR);
  for (const el of Array.from(candidates)) {
    const pdfUrl = pdfUrlForElement(el);
    if (pdfUrl) replacePdfElement(el, pdfUrl);
  }
}

async function initPdfHandling(): Promise<void> {
  if (isViewerPathname(location.pathname)) return;
  const { pdfViewerEnabled } = await storageGet<{ pdfViewerEnabled?: boolean }>("sync", "pdfViewerEnabled");
  if (pdfViewerEnabled === false) return;

  if (document.contentType === "application/pdf") {
    if (window.top === window) {
      const pdfDetectedMessage: PDFDetectedMessage = { type: MSG_PDF_DETECTED, url: location.href };
      chrome.runtime.sendMessage(pdfDetectedMessage);
    } else if (/^https?:$/.test(location.protocol)) {
      location.replace(getViewerUrl(location.href));
    }
    return;
  }

  if (!document.body) return;
  replacePdfEmbeds(document);
  let pending: ReturnType<typeof setTimeout> | null = null;
  new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      replacePdfEmbeds(document);
    }, 200);
  }).observe(document.body, { childList: true, subtree: true });
}
initPdfHandling();
