export interface PopupElements {
  card: HTMLDivElement;
  wordEl: HTMLSpanElement;
  bodyEl: HTMLDivElement;
  footerEl: HTMLDivElement;
  backBtn: HTMLButtonElement;
  navLabel: HTMLSpanElement;
  sourceEl: HTMLDivElement;
  sourceLinkEl: HTMLAnchorElement;
}

export interface PopupCallbacks {
  onClose: () => void;
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
}

export function buildShadowStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
      display: block;
    }

    .synon-card {
      position: fixed;
      z-index: 2147483647;
      max-width: 360px;
      min-width: 220px;
      background: #fff;
      border-radius: 10px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.18), 0 1px 4px rgba(0, 0, 0, 0.08);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      color: #222;
      line-height: 1.5;
      animation: synon-fade-in 0.15s ease;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    @keyframes synon-fade-in {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .synon-header {
      display: flex;
      align-items: center;
      padding: 10px 10px 8px 10px;
    }

    .synon-back {
      all: unset;
      cursor: pointer;
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      font-size: 16px;
      color: #666;
      flex-shrink: 0;
      transition: background 0.12s ease;
      margin-right: 4px;
    }

    .synon-back:hover {
      background: rgba(0, 0, 0, 0.08);
      color: #333;
    }

    .synon-back.synon-hidden {
      display: none;
    }

    .synon-word {
      font-weight: 600;
      font-size: 15px;
      color: #111;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }

    .synon-close {
      all: unset;
      cursor: pointer;
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      font-size: 16px;
      color: #666;
      flex-shrink: 0;
      transition: background 0.12s ease;
      margin-left: 4px;
    }

    .synon-close:hover {
      background: rgba(0, 0, 0, 0.08);
      color: #333;
    }

    .synon-divider {
      height: 1px;
      background: #e8e8e8;
      margin: 0 14px;
    }

    .synon-body {
      padding: 10px 14px 10px;
      white-space: pre-wrap;
      word-wrap: break-word;
      flex: 1;
      user-select: text;
      -webkit-user-select: text;
    }

    .synon-body.synon-loading {
      color: #888;
      font-style: italic;
    }

    .synon-body.synon-error {
      color: #b91c1c;
      font-size: 13px;
    }

    .synon-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding: 4px 10px 8px;
      gap: 4px;
    }

    .synon-footer.synon-hidden {
      display: none;
    }

    .synon-nav-btn {
      all: unset;
      cursor: pointer;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      font-size: 15px;
      color: #666;
      flex-shrink: 0;
      transition: background 0.12s ease;
    }

    .synon-nav-btn:hover {
      background: rgba(0, 0, 0, 0.08);
      color: #333;
    }

    .synon-nav-label {
      font-size: 12px;
      color: #999;
      min-width: 32px;
      text-align: center;
    }

    .synon-source {
      padding: 2px 14px 4px;
      font-size: 12px;
      color: #999;
    }

    .synon-source a {
      color: #4A90D9;
      text-decoration: none;
    }

    .synon-source a:hover {
      text-decoration: underline;
    }

    .synon-source.synon-hidden {
      display: none;
    }

    .synon-root {
      font-size: 12px;
      color: #888;
      font-style: italic;
      display: block;
      margin-top: 6px;
    }
  `;
  return style;
}

export function buildPopupDOM(
  shadow: ShadowRoot,
  selectedText: string,
  callbacks: PopupCallbacks
): PopupElements {
  shadow.appendChild(buildShadowStyles());

  const card = document.createElement("div");
  card.className = "synon-card";

  // Header: [back] word [close]
  const header = document.createElement("div");
  header.className = "synon-header";

  const back = document.createElement("button");
  back.className = "synon-back synon-hidden";
  back.setAttribute("aria-label", "Back");
  back.textContent = "\u2190";

  const word = document.createElement("span");
  word.className = "synon-word";
  word.textContent = selectedText;

  const closeBtn = document.createElement("button");
  closeBtn.className = "synon-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "\u00d7";

  header.appendChild(back);
  header.appendChild(word);
  header.appendChild(closeBtn);

  // Divider
  const divider = document.createElement("div");
  divider.className = "synon-divider";

  // Body
  const body = document.createElement("div");
  body.className = "synon-body synon-loading";
  body.textContent = "Defining\u2026";

  // Source attribution
  const source = document.createElement("div");
  source.className = "synon-source synon-hidden";
  const sourceLink = document.createElement("a");
  sourceLink.target = "_blank";
  sourceLink.rel = "noopener noreferrer";

  // Footer: nav arrows
  const footer = document.createElement("div");
  footer.className = "synon-footer synon-hidden";

  const prevBtn = document.createElement("button");
  prevBtn.className = "synon-nav-btn";
  prevBtn.setAttribute("aria-label", "Previous definition");
  prevBtn.textContent = "\u2039";

  const label = document.createElement("span");
  label.className = "synon-nav-label";

  const nextBtn = document.createElement("button");
  nextBtn.className = "synon-nav-btn";
  nextBtn.setAttribute("aria-label", "Next definition");
  nextBtn.textContent = "\u203a";

  footer.appendChild(prevBtn);
  footer.appendChild(label);
  footer.appendChild(nextBtn);

  card.appendChild(header);
  card.appendChild(divider);
  card.appendChild(body);
  card.appendChild(source);
  card.appendChild(footer);
  shadow.appendChild(card);

  // Wire up callbacks
  closeBtn.addEventListener("mousedown", (e: Event) => {
    e.stopPropagation();
    callbacks.onClose();
  });

  back.addEventListener("mousedown", (e: Event) => {
    e.stopPropagation();
    callbacks.onBack();
  });

  prevBtn.addEventListener("mousedown", (e: Event) => {
    e.stopPropagation();
    callbacks.onPrev();
  });

  nextBtn.addEventListener("mousedown", (e: Event) => {
    e.stopPropagation();
    callbacks.onNext();
  });

  return {
    card,
    wordEl: word,
    bodyEl: body,
    footerEl: footer,
    backBtn: back,
    navLabel: label,
    sourceEl: source,
    sourceLinkEl: sourceLink,
  };
}
