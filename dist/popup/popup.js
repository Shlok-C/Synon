"use strict";
(() => {
  // src/popup/popup.ts
  var apiKeyInput = document.getElementById("apiKey");
  var saveButton = document.getElementById("save");
  var statusDiv = document.getElementById("status");
  var definitionSection = document.getElementById("definitionSection");
  var defWord = document.getElementById("defWord");
  var defText = document.getElementById("defText");
  chrome.storage.local.get("synonPendingDefinition", (result) => {
    const pending = result.synonPendingDefinition;
    if (!pending) return;
    definitionSection.style.display = "block";
    defWord.textContent = pending.word;
    if (pending.error) {
      defText.textContent = pending.error;
      defText.classList.add("synon-error");
    } else if (pending.definition) {
      defText.textContent = pending.definition;
    } else {
      defText.textContent = "Something went wrong.";
      defText.classList.add("synon-error");
    }
    chrome.storage.local.remove("synonPendingDefinition");
    chrome.runtime.sendMessage({ type: "BADGE_CLEAR" });
  });
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
