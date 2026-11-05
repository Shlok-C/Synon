// Single source of truth for the PDF viewer's path — used both to build/parse
// extension URLs (chrome.runtime.getURL) and to check a page's own pathname
// from inside a content script running on the viewer itself.
export const VIEWER_HTML_PATH = "pdfjs/web/viewer.html";

export function isViewerPathname(pathname: string): boolean {
  return pathname.includes(VIEWER_HTML_PATH);
}

export function getViewerUrl(pdfUrl: string): string {
  return `${chrome.runtime.getURL(VIEWER_HTML_PATH)}?file=${encodeURIComponent(pdfUrl)}`;
}

export function getViewerUrlForLocalPdf(itemId: string): string {
  return `${chrome.runtime.getURL(VIEWER_HTML_PATH)}?libraryId=${encodeURIComponent(itemId)}`;
}

export function getOriginalPdfUrlFromViewerUrl(url: string): string | null {
  const viewerBase = chrome.runtime.getURL(VIEWER_HTML_PATH);
  if (!url.startsWith(viewerBase)) return null;
  try {
    return new URL(url).searchParams.get("file");
  } catch {
    return null;
  }
}
