const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const definitionSection = document.getElementById("definitionSection") as HTMLDivElement;
const defWord = document.getElementById("defWord") as HTMLDivElement;
const defText = document.getElementById("defText") as HTMLDivElement;

// Check for pending definition (PDF / no-content-script fallback)
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

  // Clear pending definition and badge
  chrome.storage.local.remove("synonPendingDefinition");
  chrome.runtime.sendMessage({ type: "BADGE_CLEAR" });
});

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
