"use strict";
(() => {
  // src/content.ts
  var HOST_ID = "synon-popup-host";
  var currentHost = null;
  var currentCard = null;
  var currentRange = null;
  var trackingRafId = null;
  var dismissedByClose = false;
  var popupStack = [];
  var currentPopupState = null;
  var wordEl = null;
  var bodyEl = null;
  var footerEl = null;
  var backBtn = null;
  var navLabel = null;
  var sourceEl = null;
  var sourceLinkEl = null;
  function isPDFPage() {
    return location.pathname.toLowerCase().endsWith(".pdf") || !!document.querySelector('embed[type="application/pdf"]');
  }
  function isEmailPage() {
    const host = location.hostname;
    return host.includes("mail.google.com") || host.includes("outlook.live.com") || host.includes("outlook.office.com") || host.includes("outlook.office365.com");
  }
  function getSelectionContainerText(selection, maxLen) {
    let node = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement ?? null;
    const MIN_USEFUL = 200;
    while (node && node !== document.body) {
      const text = node.textContent?.trim() || "";
      if (text.length >= MIN_USEFUL) return text.slice(0, maxLen);
      node = node.parentElement;
    }
    return document.body.innerText.slice(0, maxLen);
  }
  function getPDFContext(selection) {
    const container = selection.anchorNode?.parentElement;
    if (!container) return "";
    const textLayer = container.closest('[class*="textLayer"]') || container.parentElement;
    if (!textLayer) return "";
    return textLayer.textContent?.trim().slice(0, 3e3) || "";
  }
  function getEmailContext(selection) {
    const knownSelectors = [
      '[role="main"] .a3s',
      '[role="main"] .ii.gt',
      '[aria-label="Message body"]',
      ".ReadMsgBody"
    ];
    for (const sel of knownSelectors) {
      const el = document.querySelector(sel);
      if (el && el.contains(selection.anchorNode)) {
        return el.textContent?.trim().slice(0, 3e3) || "";
      }
    }
    return getSelectionContainerText(selection, 3e3);
  }
  function getGenericContext(selection) {
    const anchor = selection.anchorNode;
    if (anchor) {
      const semantic = (anchor instanceof Element ? anchor : anchor.parentElement)?.closest("article, main, [role='main']");
      if (semantic) return semantic.textContent?.trim().slice(0, 3e3) || "";
    }
    return getSelectionContainerText(selection, 3e3);
  }
  function getPageContext(selection) {
    if (isPDFPage()) return getPDFContext(selection);
    if (isEmailPage()) return getEmailContext(selection);
    return getGenericContext(selection);
  }
  function removePopup() {
    if (trackingRafId !== null) {
      cancelAnimationFrame(trackingRafId);
      trackingRafId = null;
    }
    document.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
    if (currentHost) {
      currentHost.remove();
      currentHost = null;
    }
    currentCard = null;
    currentRange = null;
    popupStack = [];
    currentPopupState = null;
    wordEl = null;
    bodyEl = null;
    footerEl = null;
    backBtn = null;
    navLabel = null;
    sourceEl = null;
    sourceLinkEl = null;
  }
  function buildShadowStyles() {
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
  `;
    return style;
  }
  function buildPopupDOM(shadow, selectedText) {
    shadow.appendChild(buildShadowStyles());
    const card = document.createElement("div");
    card.className = "synon-card";
    const header = document.createElement("div");
    header.className = "synon-header";
    const back = document.createElement("button");
    back.className = "synon-back synon-hidden";
    back.setAttribute("aria-label", "Back");
    back.textContent = "\u2190";
    backBtn = back;
    const word = document.createElement("span");
    word.className = "synon-word";
    word.textContent = selectedText;
    wordEl = word;
    const closeBtn = document.createElement("button");
    closeBtn.className = "synon-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "\xD7";
    header.appendChild(back);
    header.appendChild(word);
    header.appendChild(closeBtn);
    const divider = document.createElement("div");
    divider.className = "synon-divider";
    const body = document.createElement("div");
    body.className = "synon-body synon-loading";
    body.textContent = "Defining\u2026";
    bodyEl = body;
    const source = document.createElement("div");
    source.className = "synon-source synon-hidden";
    const sourceLink = document.createElement("a");
    sourceLink.target = "_blank";
    sourceLink.rel = "noopener noreferrer";
    sourceEl = source;
    sourceLinkEl = sourceLink;
    const footer = document.createElement("div");
    footer.className = "synon-footer synon-hidden";
    const prevBtn = document.createElement("button");
    prevBtn.className = "synon-nav-btn";
    prevBtn.setAttribute("aria-label", "Previous definition");
    prevBtn.textContent = "\u2039";
    const label = document.createElement("span");
    label.className = "synon-nav-label";
    navLabel = label;
    const nextBtn = document.createElement("button");
    nextBtn.className = "synon-nav-btn";
    nextBtn.setAttribute("aria-label", "Next definition");
    nextBtn.textContent = "\u203A";
    footer.appendChild(prevBtn);
    footer.appendChild(label);
    footer.appendChild(nextBtn);
    footerEl = footer;
    card.appendChild(header);
    card.appendChild(divider);
    card.appendChild(body);
    card.appendChild(source);
    card.appendChild(footer);
    shadow.appendChild(card);
    closeBtn.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      dismissedByClose = true;
      removePopup();
    });
    back.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (popupStack.length === 0) return;
      const prev = popupStack.pop();
      currentPopupState = prev;
      renderCurrentState();
    });
    prevBtn.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (!currentPopupState || currentPopupState.definitions.length <= 1) return;
      currentPopupState.index = (currentPopupState.index - 1 + currentPopupState.definitions.length) % currentPopupState.definitions.length;
      renderCurrentState();
    });
    nextBtn.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (!currentPopupState || currentPopupState.definitions.length <= 1) return;
      currentPopupState.index = (currentPopupState.index + 1) % currentPopupState.definitions.length;
      renderCurrentState();
    });
  }
  function renderCurrentState() {
    if (!currentPopupState || !wordEl || !bodyEl || !footerEl || !backBtn || !navLabel) return;
    const { word, definitions, index } = currentPopupState;
    wordEl.textContent = word;
    bodyEl.classList.remove("synon-loading", "synon-error");
    if (definitions.length === 0) {
      bodyEl.textContent = "Defining\u2026";
      bodyEl.classList.add("synon-loading");
      if (sourceEl) sourceEl.classList.add("synon-hidden");
    } else {
      const def = definitions[index];
      bodyEl.textContent = def.text;
      if (sourceEl && sourceLinkEl) {
        if (def.url) {
          sourceLinkEl.href = def.url;
          sourceLinkEl.textContent = def.source;
          sourceEl.textContent = "";
          sourceEl.appendChild(document.createTextNode("Source: "));
          sourceEl.appendChild(sourceLinkEl);
        } else {
          sourceEl.textContent = `Source: ${def.source}`;
        }
        sourceEl.classList.remove("synon-hidden");
      }
    }
    if (popupStack.length > 0) {
      backBtn.classList.remove("synon-hidden");
    } else {
      backBtn.classList.add("synon-hidden");
    }
    if (definitions.length > 1) {
      footerEl.classList.remove("synon-hidden");
      navLabel.textContent = `${index + 1} / ${definitions.length}`;
    } else {
      footerEl.classList.add("synon-hidden");
    }
  }
  function setLoadingState(word) {
    currentPopupState = { word, definitions: [], index: 0 };
    renderCurrentState();
  }
  function setDefinitions(definitions, error) {
    if (!currentPopupState || !bodyEl) return;
    if (error && definitions.length === 0) {
      currentPopupState.definitions = [];
      bodyEl.classList.remove("synon-loading");
      bodyEl.classList.add("synon-error");
      bodyEl.textContent = error;
      if (footerEl) footerEl.classList.add("synon-hidden");
      if (sourceEl) sourceEl.classList.add("synon-hidden");
      return;
    }
    if (definitions.length === 0) {
      bodyEl.classList.remove("synon-loading");
      bodyEl.classList.add("synon-error");
      bodyEl.textContent = "Something went wrong.";
      if (footerEl) footerEl.classList.add("synon-hidden");
      if (sourceEl) sourceEl.classList.add("synon-hidden");
      return;
    }
    currentPopupState.definitions = definitions;
    currentPopupState.index = 0;
    renderCurrentState();
  }
  function computePosition(rect) {
    const MARGIN = 8;
    const GAP = 6;
    const POPUP_HEIGHT_EST = 160;
    const POPUP_WIDTH_EST = 360;
    let top = rect.bottom + GAP;
    let left = rect.left;
    if (top + POPUP_HEIGHT_EST > window.innerHeight - MARGIN) {
      top = rect.top - GAP - POPUP_HEIGHT_EST;
    }
    if (top < MARGIN) {
      top = MARGIN;
    }
    if (left + POPUP_WIDTH_EST > window.innerWidth - MARGIN) {
      left = window.innerWidth - MARGIN - POPUP_WIDTH_EST;
    }
    if (left < MARGIN) {
      left = MARGIN;
    }
    return { left, top };
  }
  function isRectInViewport(rect) {
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth && rect.width > 0 && rect.height > 0;
  }
  function updatePopupPosition() {
    if (!currentCard || !currentRange) return;
    const rect = currentRange.getBoundingClientRect();
    if (!isRectInViewport(rect)) {
      currentCard.style.visibility = "hidden";
      return;
    }
    currentCard.style.visibility = "visible";
    const { left, top } = computePosition(rect);
    currentCard.style.left = `${left}px`;
    currentCard.style.top = `${top}px`;
  }
  function onScrollOrResize() {
    if (trackingRafId !== null) return;
    trackingRafId = requestAnimationFrame(() => {
      trackingRafId = null;
      updatePopupPosition();
    });
  }
  function showPopup(range, selectedText) {
    removePopup();
    const host = document.createElement("div");
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: "open" });
    buildPopupDOM(shadow, selectedText);
    const card = shadow.querySelector(".synon-card");
    const rect = range.getBoundingClientRect();
    const { left, top } = computePosition(rect);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    document.body.appendChild(host);
    currentHost = host;
    currentCard = card;
    currentRange = range;
    document.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    shadow.addEventListener("mouseup", (e) => {
      e.stopPropagation();
      const sel = "getSelection" in shadow ? shadow.getSelection() : document.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString().trim();
      if (!text) return;
      if (currentPopupState && text === currentPopupState.word) return;
      if (currentPopupState && currentPopupState.definitions.length > 0) {
        popupStack.push({ ...currentPopupState });
      }
      setLoadingState(text);
      const hostAtRequest = currentHost;
      chrome.runtime.sendMessage(
        { type: "DEFINE", selectedText: text, pageContext: "" },
        (response) => {
          if (currentHost !== hostAtRequest) return;
          if (chrome.runtime.lastError) {
            setDefinitions([], "Something went wrong.");
            return;
          }
          if (response?.error) {
            setDefinitions(response.definitions || [], response.error);
          } else if (response?.definitions?.length) {
            setDefinitions(response.definitions);
          } else {
            setDefinitions([], "Something went wrong.");
          }
        }
      );
      sel.removeAllRanges();
    });
  }
  document.addEventListener("mousedown", (e) => {
    if (!currentHost) return;
    if (e.composedPath().includes(currentHost)) return;
    removePopup();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      removePopup();
    }
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "SHOW_DEFINITION") return;
    const { selectedText, definitions, error } = message;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const range = selection.getRangeAt(0).cloneRange();
    showPopup(range, selectedText);
    if (error && (!definitions || definitions.length === 0)) {
      setDefinitions([], error);
    } else if (definitions?.length) {
      setDefinitions(definitions);
    } else {
      setDefinitions([], "Something went wrong.");
    }
  });
  document.addEventListener("mouseup", (e) => {
    if (currentHost && e.composedPath().includes(currentHost)) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      dismissedByClose = false;
      return;
    }
    const selectedText = selection.toString().trim();
    if (!selectedText) {
      dismissedByClose = false;
      return;
    }
    if (dismissedByClose) return;
    const range = selection.getRangeAt(0).cloneRange();
    showPopup(range, selectedText);
    setLoadingState(selectedText);
    const hostAtCreation = currentHost;
    const pageContext = getPageContext(selection);
    chrome.runtime.sendMessage(
      { type: "DEFINE", selectedText, pageContext },
      (response) => {
        if (currentHost !== hostAtCreation) return;
        if (chrome.runtime.lastError) {
          setDefinitions([], "Something went wrong.");
          return;
        }
        if (response?.error) {
          setDefinitions(response.definitions || [], response.error);
        } else if (response?.definitions?.length) {
          setDefinitions(response.definitions);
        } else {
          setDefinitions([], "Something went wrong.");
        }
      }
    );
  });
})();
