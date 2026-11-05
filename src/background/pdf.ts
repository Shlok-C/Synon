// PDF detection → redirect to Synon's viewer, and the open-PDF-tab registry
// used to reopen PDF tabs after an extension reload. The chrome.* listeners
// that call these live in index.ts.
import { getViewerUrl } from "../shared/pdf-viewer-url";

export function isOwnExtensionUrl(url: string): boolean {
  return url.startsWith(chrome.runtime.getURL(""));
}

// Decides from a main-frame response's headers whether Chrome would *display*
// it as a PDF (→ take it over with the viewer). Anything Chrome would download
// — `Content-Disposition: attachment`, or a non-PDF Content-Type such as
// application/octet-stream — is left alone so downloads behave normally.
export function isDisplayablePdfResponse(
  headers: chrome.webRequest.HttpHeader[] | undefined
): boolean {
  const header = (name: string) =>
    headers?.find((h) => h.name.toLowerCase() === name)?.value?.toLowerCase() ?? "";
  if (!header("content-type").startsWith("application/pdf")) return false;
  if (header("content-disposition").trim().startsWith("attachment")) return false;
  return true;
}

// --- Redirect bypass ---
// The viewer's "Open original" button asks for its PDF URL to be left to
// Chrome for a short window. Not consumed on first use: the same navigation can
// be seen by both the header listener and the content script's top-frame
// fallback. Stored in chrome.storage.session so a service-worker restart
// between the request and the navigation doesn't lose it.
const PDF_BYPASS_KEY = "pdfRedirectBypass";
const PDF_BYPASS_TTL_MS = 30_000;

export function bypassRedirect(pdfUrl: string): void {
  chrome.storage.session.get(PDF_BYPASS_KEY, (result) => {
    const now = Date.now();
    const entries: Record<string, number> = result[PDF_BYPASS_KEY] || {};
    for (const [url, expiry] of Object.entries(entries)) {
      if (expiry <= now) delete entries[url];
    }
    entries[pdfUrl] = now + PDF_BYPASS_TTL_MS;
    chrome.storage.session.set({ [PDF_BYPASS_KEY]: entries });
  });
}

// Redirects a tab to the Synon PDF viewer, unless the user has disabled it or
// asked (via the viewer's "Open original") to see this URL natively.
export function redirectToViewerIfEnabled(tabId: number, pdfUrl: string): void {
  chrome.storage.sync.get("pdfViewerEnabled", (result) => {
    if (result.pdfViewerEnabled === false) return;
    chrome.storage.session.get(PDF_BYPASS_KEY, (session) => {
      const expiry = (session[PDF_BYPASS_KEY] || {})[pdfUrl];
      if (typeof expiry === "number" && expiry > Date.now()) return;
      chrome.tabs.update(tabId, { url: getViewerUrl(pdfUrl) });
    });
  });
}

// --- Open PDF tab registry (survives extension reload; used to restore tabs closed by it) ---
const OPEN_PDF_TABS_KEY = "openPdfTabs";

export function registerPdfTab(tabId: number, pdfUrl: string): void {
  chrome.storage.local.get(OPEN_PDF_TABS_KEY, (result) => {
    const tabs: Record<string, string> = result[OPEN_PDF_TABS_KEY] || {};
    tabs[String(tabId)] = pdfUrl;
    chrome.storage.local.set({ [OPEN_PDF_TABS_KEY]: tabs });
  });
}

function unregisterPdfTab(tabId: number): void {
  chrome.storage.local.get(OPEN_PDF_TABS_KEY, (result) => {
    const tabs: Record<string, string> = result[OPEN_PDF_TABS_KEY] || {};
    if (!(String(tabId) in tabs)) return;
    delete tabs[String(tabId)];
    chrome.storage.local.set({ [OPEN_PDF_TABS_KEY]: tabs });
  });
}

// Deferred, not synchronous: if this tab is closing because the OLD extension
// instance's origin is being torn down for a reload, that instance's JS
// context is killed at/around the same moment — a pending setTimeout in it
// never fires, so this registry entry survives untouched for the NEW
// instance's restore read moments later. If the tab closed during ordinary
// operation, the prune still happens ~5s later (imperceptible; the registry
// is only ever consulted at the next reload).
const PDF_UNREGISTER_DELAY_MS = 5000;

export function scheduleUnregisterPdfTab(tabId: number): void {
  setTimeout(() => unregisterPdfTab(tabId), PDF_UNREGISTER_DELAY_MS);
}

// After an extension update/reload: reopen every registered PDF in a new
// inactive tab (unless the user turned pdfReopenOnReload off).
export function reopenRegisteredPdfTabs(): void {
  chrome.storage.sync.get("pdfReopenOnReload", (settings) => {
    if (settings.pdfReopenOnReload === false) return;

    chrome.storage.local.get(OPEN_PDF_TABS_KEY, (result) => {
      const tabs: Record<string, string> = result[OPEN_PDF_TABS_KEY] || {};
      // Multiple tabIds can legitimately map to the same URL (the same PDF
      // open in two tabs, or a close+reopen racing the delayed unregister) —
      // restore at most one tab per unique PDF.
      const uniquePdfUrls = Array.from(new Set(Object.values(tabs)));
      if (uniquePdfUrls.length === 0) return;

      // Old tab IDs are stale after a reload — clear before recreating.
      chrome.storage.local.set({ [OPEN_PDF_TABS_KEY]: {} });

      for (const pdfUrl of uniquePdfUrls) {
        // Registration of the new tab is left to its own viewer.js self-report
        // (MSG_PDF_VIEWER_OPENED) — same single-source-of-truth pattern as
        // onBeforeNavigate and MSG_PDF_DETECTED.
        chrome.tabs.create({ url: getViewerUrl(pdfUrl), active: false });
      }
    });
  });
}
