const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const testButton = document.getElementById("test") as HTMLButtonElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const exactModeCheckbox = document.getElementById("exactMode") as HTMLInputElement;
const verbositySlider = document.getElementById("verbosity") as HTMLInputElement;
const verbosityLabel = document.getElementById("verbosityLabel") as HTMLSpanElement;
const quietModeCheckbox = document.getElementById("quietMode") as HTMLInputElement;
const pdfViewerCheckbox = document.getElementById("pdfViewer") as HTMLInputElement;

const VERBOSITY_LABELS: Record<string, string> = {
  "1": "Minimal",
  "2": "Brief",
  "3": "Standard",
  "4": "Detailed",
  "5": "Full",
};

function updateVerbosityLabel(value: string): void {
  verbosityLabel.textContent = VERBOSITY_LABELS[value] || "Standard";
}

// Load saved settings on popup open
chrome.storage.sync.get(["apiKey", "exactMode", "quietMode", "verbosity", "pdfViewerEnabled"], (result) => {
  if (result.apiKey) {
    apiKeyInput.value = result.apiKey;
    statusDiv.textContent = "API key is saved.";
  }
  exactModeCheckbox.checked = result.exactMode === true;
  quietModeCheckbox.checked = result.quietMode !== false; // default true
  const v = result.verbosity ?? 3;
  verbositySlider.value = String(v);
  updateVerbosityLabel(String(v));
  pdfViewerCheckbox.checked = result.pdfViewerEnabled !== false; // default true
});

exactModeCheckbox.addEventListener("change", () => {
  chrome.storage.sync.set({ exactMode: exactModeCheckbox.checked });
});

quietModeCheckbox.addEventListener("change", () => {
  chrome.storage.sync.set({ quietMode: quietModeCheckbox.checked });
});

pdfViewerCheckbox.addEventListener("change", () => {
  chrome.storage.sync.set({ pdfViewerEnabled: pdfViewerCheckbox.checked });
});

verbositySlider.addEventListener("input", () => {
  updateVerbosityLabel(verbositySlider.value);
  chrome.storage.sync.set({ verbosity: parseInt(verbositySlider.value, 10) });
});

function isValidApiKeyFormat(key: string): boolean {
  return key.startsWith("sk-or-") && key.length >= 40;
}

saveButton.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    statusDiv.textContent = "Please enter an API key.";
    return;
  }
  if (!isValidApiKeyFormat(key)) {
    statusDiv.textContent = "Invalid format. OpenRouter keys start with sk-or-";
    return;
  }

  chrome.storage.sync.set({ apiKey: key }, () => {
    statusDiv.textContent = "API key saved.";
  });
});

testButton.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    statusDiv.textContent = "Please enter an API key first.";
    return;
  }
  if (!isValidApiKeyFormat(key)) {
    statusDiv.textContent = "Invalid format. OpenRouter keys start with sk-or-";
    return;
  }
  statusDiv.textContent = "Testing...";
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "Authorization": `Bearer ${key}` },
    });
    statusDiv.textContent = resp.ok ? "Key is valid!" : "Key rejected by API.";
  } catch {
    statusDiv.textContent = "Network error — couldn't test key.";
  }
});
