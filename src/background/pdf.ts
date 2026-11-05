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
// One chrome.storage.local key per tab ("pdfTab:<tabId>" → PDF URL), never a
// shared object: every write is a single set/remove, so viewer tabs that
// register at the same moment (most of all the batch reopened after a reload)
// can't overwrite each other's entries — a shared get→mutate→set map lost
// entries that way and shrank with every reload.
const PDF_TAB_KEY_PREFIX = "pdfTab:";
// Pre-2026-11 registry format (one shared map); read once by the restore, then deleted.
const LEGACY_OPEN_PDF_TABS_KEY = "openPdfTabs";

const pdfTabKey = (tabId: number) => `${PDF_TAB_KEY_PREFIX}${tabId}`;

export function registerPdfTab(tabId: number, pdfUrl: string): void {
  chrome.storage.local.set({ [pdfTabKey(tabId)]: pdfUrl });
}

// Called the moment a tab closes or leaves the viewer — not deferred. Measured
// against real extension reloads: the reload's own teardown of viewer tabs never
// reaches a worker's onRemoved before the new instance's restore read, whereas a
// deferred removal died with the old worker, so a tab the user closed just
// before reloading came back. A tab that was never a PDF has no key: no-op.
export function unregisterPdfTab(tabId: number): void {
  chrome.storage.local.remove(pdfTabKey(tabId));
}

async function readRegistry(): Promise<Record<string, string>> {
  const all = await chrome.storage.local.get(null);
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PDF_TAB_KEY_PREFIX) && typeof value === "string") entries[key] = value;
  }
  return entries;
}

// On browser startup: tab IDs don't survive a restart, so any entry whose tab
// doesn't exist is left over from a session that ended without onRemoved
// firing (crash, or shutdown with the worker asleep) and would otherwise
// reopen a long-closed PDF at the next reload. Viewer tabs restored by Chrome
// re-register themselves under their new IDs.
export async function pruneStalePdfTabs(): Promise<void> {
  const [entries, tabs] = await Promise.all([readRegistry(), chrome.tabs.query({})]);
  const liveKeys = new Set(tabs.map((t) => (t.id != null ? pdfTabKey(t.id) : "")));
  const stale = Object.keys(entries).filter((key) => !liveKeys.has(key));
  if (stale.length) await chrome.storage.local.remove(stale);
}

// After an extension update/reload: reopen every registered PDF in a new
// inactive tab (unless the user turned pdfReopenOnReload off).
export async function reopenRegisteredPdfTabs(): Promise<void> {
  const settings = await chrome.storage.sync.get("pdfReopenOnReload");
  if (settings.pdfReopenOnReload === false) return;

  const entries = await readRegistry();
  const legacy = (await chrome.storage.local.get(LEGACY_OPEN_PDF_TABS_KEY))[LEGACY_OPEN_PDF_TABS_KEY] as
    | Record<string, string>
    | undefined;
  // The same PDF can be open in two tabs — restore at most one per URL.
  const uniquePdfUrls = Array.from(new Set([...Object.values(entries), ...Object.values(legacy ?? {})]));

  // Old tab IDs are stale after a reload. Remove exactly those keys, and before
  // creating tabs, so the new tabs' own registrations are never caught by it.
  await chrome.storage.local.remove([...Object.keys(entries), LEGACY_OPEN_PDF_TABS_KEY]);

  for (const pdfUrl of uniquePdfUrls) {
    // The new tab registers itself via its viewer.js self-report (MSG_PDF_VIEWER_OPENED).
    chrome.tabs.create({ url: getViewerUrl(pdfUrl), active: false });
  }
}
