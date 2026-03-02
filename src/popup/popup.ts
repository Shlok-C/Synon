const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const exactModeCheckbox = document.getElementById("exactMode") as HTMLInputElement;

// Load saved settings on popup open
chrome.storage.sync.get(["apiKey", "exactMode"], (result) => {
  if (result.apiKey) {
    apiKeyInput.value = result.apiKey;
    statusDiv.textContent = "API key is saved.";
  }
  exactModeCheckbox.checked = result.exactMode === true;
});

exactModeCheckbox.addEventListener("change", () => {
  chrome.storage.sync.set({ exactMode: exactModeCheckbox.checked });
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
