"use strict";
(() => {
  // src/popup/popup.ts
  var apiKeyInput = document.getElementById("apiKey");
  var saveButton = document.getElementById("save");
  var statusDiv = document.getElementById("status");
  chrome.storage.sync.get("apiKey", (result) => {
    if (result.apiKey) {
      apiKeyInput.value = result.apiKey;
      statusDiv.textContent = "API key is saved.";
    }
  });
  saveButton.addEventListener("click", () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      statusDiv.textContent = "Please enter an API key.";
      return;
    }
    chrome.storage.sync.set({ apiKey: key }, () => {
      statusDiv.textContent = "API key saved.";
    });
  });
})();
