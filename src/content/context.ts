export function isEmailPage(): boolean {
  const host = location.hostname;
  return (
    host.includes("mail.google.com") ||
    host.includes("outlook.live.com") ||
    host.includes("outlook.office.com") ||
    host.includes("outlook.office365.com")
  );
}

function getSelectionContainerText(selection: Selection, maxLen: number): string {
  let node: Element | null =
    selection.anchorNode instanceof Element
      ? selection.anchorNode
      : selection.anchorNode?.parentElement ?? null;

  const MIN_USEFUL = 200;
  while (node && node !== document.body) {
    const text = node.textContent?.trim() || "";
    if (text.length >= MIN_USEFUL) return text.slice(0, maxLen);
    node = node.parentElement;
  }

  return document.body.innerText.slice(0, maxLen);
}

function getEmailContext(selection: Selection): string {
  const knownSelectors = [
    '[role="main"] .a3s',
    '[role="main"] .ii.gt',
    '[aria-label="Message body"]',
    '.ReadMsgBody',
  ];

  for (const sel of knownSelectors) {
    const el = document.querySelector(sel);
    if (el && el.contains(selection.anchorNode)) {
      return el.textContent?.trim().slice(0, 3000) || "";
    }
  }

  return getSelectionContainerText(selection, 3000);
}

function getGenericContext(selection: Selection): string {
  const anchor = selection.anchorNode;
  if (anchor) {
    const semantic = (anchor instanceof Element ? anchor : anchor.parentElement)
      ?.closest("article, main, [role='main']");
    if (semantic) return semantic.textContent?.trim().slice(0, 3000) || "";
  }

  return getSelectionContainerText(selection, 3000);
}

function isPDFPage(): boolean {
  return location.pathname.includes("pdfjs/web/viewer.html");
}

function getPDFContext(selection: Selection): string {
  const anchor = selection.anchorNode;
  if (!anchor) return "";

  const pageEl = (anchor instanceof Element ? anchor : anchor.parentElement)
    ?.closest(".page");
  if (!pageEl) {
    // Fallback: grab all visible text layer content
    const spans = document.querySelectorAll(".textLayer span");
    return Array.from(spans).map(s => s.textContent).join(" ").slice(0, 3000);
  }

  // Grab current page + adjacent pages for context
  const pageNum = parseInt(pageEl.getAttribute("data-page-number") || "0", 10);
  const pages: string[] = [];
  for (let p = pageNum - 1; p <= pageNum + 1; p++) {
    const page = document.querySelector(`.page[data-page-number="${p}"]`);
    if (page) {
      const text = Array.from(page.querySelectorAll(".textLayer span"))
        .map(s => s.textContent).join(" ").trim();
      if (text) pages.push(text);
    }
  }
  return pages.join("\n\n").slice(0, 3000);
}

export function getPageContext(selection: Selection): string {
  if (isPDFPage()) return getPDFContext(selection);
  if (isEmailPage()) return getEmailContext(selection);
  return getGenericContext(selection);
}
