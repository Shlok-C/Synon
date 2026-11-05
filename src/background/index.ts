// Service worker entry point: every chrome.* event listener is registered
// here and delegates to the feature modules (define, openrouter, pdf).
import { normalizeSelection } from "../shared/validation";
import type { Definition } from "../shared/types";
import {
  MSG_DEFINE,
  MSG_DEFINE_PARTIAL,
  MSG_DEFINE_RESULT,
  MSG_SHOW_DEFINITION,
  MSG_PDF_DETECTED,
  MSG_PDF_VIEWER_OPENED,
  MSG_PDF_BYPASS,
  MSG_GENERATE_PDF_OUTLINE,
  MSG_SWITCH_TAB,
  MSG_WARMUP,
  DEFINE_PORT_NAME,
} from "../shared/messages";
import type {
  DefineMessage,
  DefinePartialMessage,
  DefineResultMessage,
  ShowDefinitionMessage,
  PDFDetectedMessage,
  PDFViewerOpenedMessage,
  PDFBypassMessage,
  GeneratePdfOutlineMessage,
  SwitchTabMessage,
} from "../shared/messages";
import { addTabToLibrary } from "../shared/library-db";
import { getOriginalPdfUrlFromViewerUrl } from "../shared/pdf-viewer-url";
import { handleDefine } from "./define";
import { generatePdfOutline } from "./openrouter";
import {
  isOwnExtensionUrl,
  isDisplayablePdfResponse,
  bypassRedirect,
  redirectToViewerIfEnabled,
  registerPdfTab,
  unregisterPdfTab,
  pruneStalePdfTabs,
  reopenRegisteredPdfTabs,
} from "./pdf";

// --- Library ---
async function addPageToLibrary(tab: chrome.tabs.Tab | undefined): Promise<void> {
  if (!tab?.id || !tab.url) return;
  await addTabToLibrary({ id: tab.id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl });
}

// Activates the neighbouring tab in the sender's window, wrapping at the ends.
// Looks the sender up by id rather than trusting sender.tab.index, which can be
// stale if tabs were reordered while the message was in flight.
async function switchTab(fromTab: chrome.tabs.Tab, direction: SwitchTabMessage["direction"]) {
  const tabs = await chrome.tabs.query({ windowId: fromTab.windowId });
  const i = tabs.findIndex((t) => t.id === fromTab.id);
  if (i === -1 || tabs.length < 2) return;
  const target = tabs[(i + (direction === "next" ? 1 : -1) + tabs.length) % tabs.length];
  if (target.id != null) await chrome.tabs.update(target.id, { active: true });
}

// --- PDF detection ---
// Reopen-on-reload registry upkeep: a tab leaves it when it's closed or when it
// navigates away from the viewer; it joins via the viewer's own
// MSG_PDF_VIEWER_OPENED (below), which also re-registers in-viewer PDF changes.
chrome.tabs.onRemoved.addListener((tabId) => {
  unregisterPdfTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && getOriginalPdfUrlFromViewerUrl(changeInfo.url) === null) {
    unregisterPdfTab(tabId);
  }
});

chrome.runtime.onStartup.addListener(() => {
  pruneStalePdfTabs();
});

// Embedded PDFs (<embed>/<object>/<iframe> in a page) are swapped for the
// viewer in place by the content script, not detected here.
// Header-based PDF detection — the single top-level detection path. Runs on
// the response (not onBeforeNavigate's bare URL) so it can tell a PDF Chrome
// would display from one it would download: `Content-Disposition: attachment`
// and non-PDF Content-Types are left alone. Also covers PDFs without a .pdf
// extension (arXiv's /pdf/<id>). Non-blocking observer — MV3 disallows
// blocking webRequest for regular extensions — so the redirect is a separate
// chrome.tabs.update call.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (isOwnExtensionUrl(details.url)) return;
    if (!isDisplayablePdfResponse(details.responseHeaders)) return;
    redirectToViewerIfEnabled(details.tabId, details.url);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["responseHeaders"]
);

// --- Context menu + PDF tab restore ---
chrome.runtime.onInstalled.addListener((details) => {
  // One-time cleanup of the diagnostic log left behind by the now-removed
  // PDF-tab-reopen debug scaffolding.
  chrome.storage.local.remove("pdfRestoreDebugLog");

  chrome.contextMenus.create({
    id: "synon-define",
    title: 'Define "%s"',
    contexts: ["selection"],
  });

  chrome.contextMenus.create({
    id: "synon-add-library",
    title: "Add page to Library",
    contexts: ["page", "selection"],
  });

  if (details.reason === "update") reopenRegisteredPdfTabs();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "synon-add-library") {
    await addPageToLibrary(tab);
    return;
  }

  if (info.menuItemId !== "synon-define" || !info.selectionText) return;

  const selectedText = normalizeSelection(info.selectionText.trim());
  if (!selectedText) return;

  const result = await handleDefine(selectedText, "", true, 3, "generic");

  if (tab?.id) {
    try {
      const showDefinitionMessage: ShowDefinitionMessage = {
        type: MSG_SHOW_DEFINITION,
        selectedText,
        definitions: result.definitions,
        error: result.error,
      };
      await chrome.tabs.sendMessage(tab.id, showDefinitionMessage);
    } catch {
      // Content script not available — no popup possible
    }
  }
});

// --- Define requests (port-based, so interim results can be streamed) ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== DEFINE_PORT_NAME) return;
  let open = true;
  port.onDisconnect.addListener(() => { open = false; });
  port.onMessage.addListener((message: DefineMessage) => {
    if (message.type !== MSG_DEFINE) return;
    const { selectedText, pageContext, exactMode, verbosity, pageKind } = message;
    const onPartial = (definitions: Definition[]) => {
      if (!open) return;
      const partial: DefinePartialMessage = { type: MSG_DEFINE_PARTIAL, definitions };
      port.postMessage(partial);
    };
    handleDefine(selectedText, pageContext, exactMode ?? false, verbosity ?? 3, pageKind ?? "generic", onPartial)
      .then((response) => {
        if (!open) return; // popup closed / content timed out meanwhile
        const result: DefineResultMessage = { type: MSG_DEFINE_RESULT, response };
        port.postMessage(result);
        port.disconnect();
      });
  });
});

// --- Message handling ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Receiving it is the point — it woke the service worker. Nothing to reply.
  if (message.type === MSG_WARMUP) return false;

  // Fallback for a top-level PDF document the header listener missed. Only the
  // top frame may redirect the tab — PDFs inside a page are replaced in place
  // by the content script, never by navigating away from the host page.
  if (message.type === MSG_PDF_DETECTED) {
    const { url } = message as PDFDetectedMessage;
    const tabId = sender.tab?.id;
    if (tabId != null && sender.frameId === 0) {
      redirectToViewerIfEnabled(tabId, url);
    }
    return false;
  }

  if (message.type === MSG_PDF_BYPASS) {
    bypassRedirect((message as PDFBypassMessage).url);
    sendResponse(true); // the viewer waits for this before navigating
    return false;
  }

  // Self-reported by the viewer page on every load — fresh redirect, Chrome's
  // own tab/session restore, or a manually pasted viewer URL all land here.
  if (message.type === MSG_PDF_VIEWER_OPENED) {
    const { url } = message as PDFViewerOpenedMessage;
    const tabId = sender.tab?.id;
    if (tabId != null) {
      registerPdfTab(tabId, url);
    }
    return false;
  }

  if (message.type === MSG_GENERATE_PDF_OUTLINE) {
    const { candidates } = message as GeneratePdfOutlineMessage;
    generatePdfOutline(candidates).then(sendResponse);
    return true;
  }

  // Ctrl+←/→ from a content script or the PDF viewer
  if (message.type === MSG_SWITCH_TAB) {
    const { direction } = message as SwitchTabMessage;
    if (sender.tab) switchTab(sender.tab, direction);
    return false;
  }

  return false;
});
