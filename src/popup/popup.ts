const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;

// Load saved key on popup open
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
