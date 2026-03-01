"use strict";
(() => {
  // src/content.ts
  var POPUP_ID = "synon-popup";
  function getPageContext() {
    return document.body.innerText.slice(0, 5e3);
  }
  function removePopup() {
    document.getElementById(POPUP_ID)?.remove();
  }
  function showPopup(x, y, text) {
    removePopup();
    const popup = document.createElement("div");
    popup.id = POPUP_ID;
    popup.textContent = text;
    Object.assign(popup.style, {
      position: "fixed",
      left: `${x}px`,
      top: `${y}px`,
      background: "#fff",
      border: "1px solid #ccc",
      padding: "8px 12px",
      borderRadius: "6px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      zIndex: "999999",
      fontFamily: "system-ui, sans-serif",
      fontSize: "14px",
      color: "#222"
    });
    document.body.appendChild(popup);
  }
  document.addEventListener("mousedown", () => {
    removePopup();
  });
  document.addEventListener("mouseup", () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const selectedText = selection.toString().trim();
    if (!selectedText) return;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    showPopup(rect.left, rect.bottom + 4, "Hello World");
    const pageContext = getPageContext();
    chrome.runtime.sendMessage(
      { type: "DEFINE", selectedText, pageContext },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error("Synon:", chrome.runtime.lastError.message);
          return;
        }
        console.log("Synon definition:", response?.definition);
      }
    );
  });
})();
