import {
  addItem,
  addTabToLibrary,
  listItems,
  listFolders,
  createFolder,
  deleteItem,
  moveItemToFolder,
  moveFolderOrder,
  renameItem,
  renameFolder,
  deleteFolder,
} from "../shared/library-db";
import type { LibraryItem, LibraryFolder } from "../shared/types";
import { getViewerUrl, getViewerUrlForLocalPdf } from "../shared/pdf-viewer-url";
import { storageGet } from "../shared/storage";

// --- Shared UI collapse-state (settings groups + library folder tree) ---
const UI_STATE_KEY = "synonUiState";

async function loadUiState(): Promise<Record<string, boolean>> {
  const result = await storageGet<Record<string, Record<string, boolean> | undefined>>("local", UI_STATE_KEY);
  return result[UI_STATE_KEY] || {};
}

async function saveUiOpenState(key: string, open: boolean): Promise<void> {
  const state = await loadUiState();
  state[key] = open;
  chrome.storage.local.set({ [UI_STATE_KEY]: state });
}

async function applyPersistedOpenState(el: HTMLDetailsElement, key: string): Promise<void> {
  const state = await loadUiState();
  el.open = state[key] ?? true;
  el.addEventListener("toggle", () => {
    void saveUiOpenState(key, el.open);
  });
}

const tabSettingsBtn = document.getElementById("tabSettingsBtn") as HTMLButtonElement;
const tabLibraryBtn = document.getElementById("tabLibraryBtn") as HTMLButtonElement;
const settingsTab = document.getElementById("settingsTab") as HTMLDivElement;
const libraryTab = document.getElementById("libraryTab") as HTMLDivElement;

function switchTab(tab: "settings" | "library"): void {
  settingsTab.hidden = tab !== "settings";
  libraryTab.hidden = tab !== "library";
  tabSettingsBtn.classList.toggle("active", tab === "settings");
  tabLibraryBtn.classList.toggle("active", tab === "library");
  if (tab === "library") void renderLibrary();
}

tabSettingsBtn.addEventListener("click", () => switchTab("settings"));
tabLibraryBtn.addEventListener("click", () => switchTab("library"));

const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const testButton = document.getElementById("test") as HTMLButtonElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const exactModeCheckbox = document.getElementById("exactMode") as HTMLInputElement;
const verbositySlider = document.getElementById("verbosity") as HTMLInputElement;
const verbosityLabel = document.getElementById("verbosityLabel") as HTMLSpanElement;
const quietModeCheckbox = document.getElementById("quietMode") as HTMLInputElement;
const pdfViewerCheckbox = document.getElementById("pdfViewer") as HTMLInputElement;
const pdfReopenOnReloadCheckbox = document.getElementById("pdfReopenOnReload") as HTMLInputElement;
const pdfPerfSection = document.getElementById("pdfPerf") as HTMLDetailsElement;
const grpApi = document.getElementById("grpApi") as HTMLDetailsElement;
const grpDefinitions = document.getElementById("grpDefinitions") as HTMLDetailsElement;
const grpPdf = document.getElementById("grpPdf") as HTMLDetailsElement;
const pdfStreamingCheckbox = document.getElementById("pdfStreaming") as HTMLInputElement;
const pdfRenderWindowSlider = document.getElementById("pdfRenderWindow") as HTMLInputElement;
const pdfRenderWindowLabel = document.getElementById("pdfRenderWindowLabel") as HTMLSpanElement;
const pdfOutlineCapSlider = document.getElementById("pdfOutlineCap") as HTMLInputElement;
const pdfOutlineCapLabel = document.getElementById("pdfOutlineCapLabel") as HTMLSpanElement;

const PDF_RENDER_WINDOW_DEFAULT = 6;
const PDF_OUTLINE_CAP_DEFAULT = 250;

function updateRenderWindowLabel(value: string): void {
  pdfRenderWindowLabel.textContent = `${value} each side`;
}

function updateOutlineCapLabel(value: string): void {
  pdfOutlineCapLabel.textContent = `${value} pages`;
}

function syncPdfPerfVisibility(): void {
  pdfPerfSection.hidden = !pdfViewerCheckbox.checked;
}

void applyPersistedOpenState(grpApi, "settings:api");
void applyPersistedOpenState(grpDefinitions, "settings:definitions");
void applyPersistedOpenState(grpPdf, "settings:pdf");
void applyPersistedOpenState(pdfPerfSection, "settings:pdfPerf");

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

// Declarative wiring for the Settings tab's checkboxes and sliders — each
// loads from and persists to chrome.storage.sync under its own key.
interface CheckboxSetting {
  el: HTMLInputElement;
  key: string;
  default: boolean; // storage value to assume when the key is unset
  onChange?: () => void; // extra side effect after persisting
}

const CHECKBOX_SETTINGS: CheckboxSetting[] = [
  { el: exactModeCheckbox, key: "exactMode", default: false },
  { el: quietModeCheckbox, key: "quietMode", default: true },
  { el: pdfViewerCheckbox, key: "pdfViewerEnabled", default: true, onChange: syncPdfPerfVisibility },
  { el: pdfReopenOnReloadCheckbox, key: "pdfReopenOnReload", default: true },
  { el: pdfStreamingCheckbox, key: "pdfStreaming", default: true },
];

interface SliderSetting {
  el: HTMLInputElement;
  key: string;
  default: number;
  updateLabel: (value: string) => void;
}

const SLIDER_SETTINGS: SliderSetting[] = [
  { el: pdfRenderWindowSlider, key: "pdfRenderWindow", default: PDF_RENDER_WINDOW_DEFAULT, updateLabel: updateRenderWindowLabel },
  { el: pdfOutlineCapSlider, key: "pdfOutlineScanCap", default: PDF_OUTLINE_CAP_DEFAULT, updateLabel: updateOutlineCapLabel },
  { el: verbositySlider, key: "verbosity", default: 3, updateLabel: updateVerbosityLabel },
];

for (const setting of CHECKBOX_SETTINGS) {
  setting.el.addEventListener("change", () => {
    chrome.storage.sync.set({ [setting.key]: setting.el.checked });
    setting.onChange?.();
  });
}

for (const setting of SLIDER_SETTINGS) {
  setting.el.addEventListener("input", () => {
    setting.updateLabel(setting.el.value);
    chrome.storage.sync.set({ [setting.key]: parseInt(setting.el.value, 10) });
  });
}

// Load saved settings on popup open
chrome.storage.sync.get(
  ["apiKey", ...CHECKBOX_SETTINGS.map((s) => s.key), ...SLIDER_SETTINGS.map((s) => s.key)],
  (result) => {
    if (result.apiKey) {
      apiKeyInput.value = result.apiKey;
      statusDiv.textContent = "API key is saved.";
    }
    if (__OPENROUTERS_KEY__) {
      apiKeyInput.disabled = true;
      saveButton.disabled = true;
      testButton.disabled = true;
      statusDiv.textContent = "Using a built-in API key for now — your key is saved but not active.";
    }

    for (const setting of CHECKBOX_SETTINGS) {
      const stored = result[setting.key];
      setting.el.checked = setting.default ? stored !== false : stored === true;
    }

    for (const setting of SLIDER_SETTINGS) {
      const value = result[setting.key] ?? setting.default;
      setting.el.value = String(value);
      setting.updateLabel(String(value));
    }

    syncPdfPerfVisibility();
  }
);

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

// --- Library ---
const addCurrentPageBtn = document.getElementById("addCurrentPageBtn") as HTMLButtonElement;
const uploadPdfBtn = document.getElementById("uploadPdfBtn") as HTMLButtonElement;
const uploadPdfInput = document.getElementById("uploadPdfInput") as HTMLInputElement;
const libStatus = document.getElementById("libStatus") as HTMLDivElement;
const newFolderNameInput = document.getElementById("newFolderName") as HTMLInputElement;
const createFolderBtn = document.getElementById("createFolderBtn") as HTMLButtonElement;
const libraryTreeEl = document.getElementById("libraryTree") as HTMLDivElement;

function openLibraryItem(item: LibraryItem): void {
  if (item.type === "article") {
    if (item.url) chrome.tabs.create({ url: item.url });
    return;
  }
  if (item.sourceKind === "local") {
    chrome.tabs.create({ url: getViewerUrlForLocalPdf(item.id) });
  } else if (item.url) {
    chrome.tabs.create({ url: getViewerUrl(item.url) });
  }
}

function startInlineRename(
  container: Element,
  displayEl: HTMLElement,
  currentValue: string,
  commit: (newValue: string) => Promise<void>
): void {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "lib-inline-input";
  input.value = currentValue;
  container.replaceChild(input, displayEl);
  input.focus();
  input.select();

  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());

  let cancelled = false;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelled = true;
      void renderLibrary();
    }
  });

  input.addEventListener("blur", () => {
    if (cancelled) return;
    void (async () => {
      const newValue = input.value.trim();
      if (newValue && newValue !== currentValue) await commit(newValue);
      await renderLibrary();
    })();
  });
}

function buildItemRow(item: LibraryItem, folders: LibraryFolder[]): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "lib-item";
  row.title = item.title;

  const badge = document.createElement("span");
  badge.className = "lib-item-badge";
  badge.textContent = item.type;
  row.appendChild(badge);

  const title = document.createElement("span");
  title.className = "lib-item-title";
  title.textContent = item.title;
  title.title = item.title;
  row.appendChild(title);

  const folderSelect = document.createElement("select");
  folderSelect.append(new Option("Unfiled", ""));
  for (const folder of folders) folderSelect.append(new Option(folder.name, folder.id));
  folderSelect.value = item.folderId ?? "";
  folderSelect.addEventListener("change", async () => {
    await moveItemToFolder(item.id, folderSelect.value || null);
    await renderLibrary();
  });
  row.appendChild(folderSelect);

  const openBtn = document.createElement("button");
  openBtn.textContent = "↗";
  openBtn.title = "Open";
  openBtn.addEventListener("click", () => openLibraryItem(item));
  row.appendChild(openBtn);

  const renameBtn = document.createElement("button");
  renameBtn.textContent = "✎";
  renameBtn.title = "Rename";
  renameBtn.addEventListener("click", () => {
    startInlineRename(row, title, item.title, (newTitle) => renameItem(item.id, newTitle));
  });
  row.appendChild(renameBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.textContent = "🗑";
  deleteBtn.title = "Delete";
  deleteBtn.addEventListener("click", async () => {
    await deleteItem(item.id);
    await renderLibrary();
  });
  row.appendChild(deleteBtn);

  return row;
}

function buildFolderNode(
  folder: LibraryFolder,
  items: LibraryItem[],
  allFolders: LibraryFolder[],
  isFirst: boolean,
  isLast: boolean
): HTMLDetailsElement {
  const node = document.createElement("details");
  node.className = "folder-node";

  const summary = document.createElement("summary");

  const name = document.createElement("span");
  name.className = "folder-node-name";
  name.textContent = folder.name;
  name.title = folder.name;
  summary.appendChild(name);

  const count = document.createElement("span");
  count.className = "folder-node-count";
  count.textContent = String(items.length);
  summary.appendChild(count);

  const actions = document.createElement("span");
  actions.className = "folder-node-actions";

  const renameBtn = document.createElement("button");
  renameBtn.textContent = "✎";
  renameBtn.title = "Rename folder";
  renameBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startInlineRename(summary, name, folder.name, (newName) => renameFolder(folder.id, newName));
  });
  actions.appendChild(renameBtn);

  const deleteFolderBtn = document.createElement("button");
  deleteFolderBtn.textContent = "🗑";
  deleteFolderBtn.title = "Delete folder";
  deleteFolderBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await deleteFolder(folder.id);
    await renderLibrary();
  });
  actions.appendChild(deleteFolderBtn);

  const upBtn = document.createElement("button");
  upBtn.textContent = "▲";
  upBtn.title = "Move folder up";
  upBtn.disabled = isFirst;
  upBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void moveFolderOrder(folder.id, "up").then(renderLibrary);
  });
  actions.appendChild(upBtn);

  const downBtn = document.createElement("button");
  downBtn.textContent = "▼";
  downBtn.title = "Move folder down";
  downBtn.disabled = isLast;
  downBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void moveFolderOrder(folder.id, "down").then(renderLibrary);
  });
  actions.appendChild(downBtn);

  summary.appendChild(actions);
  node.appendChild(summary);
  node.appendChild(buildFolderBody(items, allFolders, "No items in this folder."));

  void applyPersistedOpenState(node, `library:folder:${folder.id}`);

  return node;
}

function buildFolderBody(items: LibraryItem[], allFolders: LibraryFolder[], emptyText: string): HTMLDivElement {
  const body = document.createElement("div");
  body.className = "folder-node-body";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "folder-node-empty";
    empty.textContent = emptyText;
    body.appendChild(empty);
    return body;
  }

  for (const item of items.sort((a, b) => b.dateAdded - a.dateAdded)) {
    body.appendChild(buildItemRow(item, allFolders));
  }
  return body;
}

async function renderLibrary(): Promise<void> {
  const [folders, allItems] = await Promise.all([listFolders(), listItems()]);
  const unfiledItems = allItems.filter((i) => i.folderId === null);

  libraryTreeEl.innerHTML = "";

  if (folders.length === 0 && unfiledItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "lib-empty";
    empty.textContent = "No items yet.";
    libraryTreeEl.appendChild(empty);
    return;
  }

  folders.forEach((folder, index) => {
    const items = allItems.filter((i) => i.folderId === folder.id);
    libraryTreeEl.appendChild(
      buildFolderNode(folder, items, folders, index === 0, index === folders.length - 1)
    );
  });

  if (unfiledItems.length > 0) {
    const label = document.createElement("div");
    label.className = "lib-unfiled-label";
    label.textContent = "Unfiled";
    libraryTreeEl.appendChild(label);
    for (const item of unfiledItems.sort((a, b) => b.dateAdded - a.dateAdded)) {
      libraryTreeEl.appendChild(buildItemRow(item, folders));
    }
  }
}

createFolderBtn.addEventListener("click", async () => {
  const name = newFolderNameInput.value.trim();
  if (!name) return;
  await createFolder(name);
  newFolderNameInput.value = "";
  await renderLibrary();
});

addCurrentPageBtn.addEventListener("click", async () => {
  libStatus.textContent = "Saving...";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    libStatus.textContent = "No active tab.";
    return;
  }

  try {
    await addTabToLibrary({ id: tab.id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl });
    libStatus.textContent = "Added to Library.";
    await renderLibrary();
  } catch {
    libStatus.textContent = "Couldn't save this page.";
  }
});

uploadPdfBtn.addEventListener("click", () => uploadPdfInput.click());

uploadPdfInput.addEventListener("change", async () => {
  const file = uploadPdfInput.files?.[0];
  uploadPdfInput.value = "";
  if (!file) return;

  libStatus.textContent = "Uploading...";
  try {
    const bytes = await file.arrayBuffer();
    await addItem({
      type: "pdf",
      sourceKind: "local",
      url: null,
      title: file.name,
      faviconUrl: null,
      snapshotText: null,
      pdfBytes: new Blob([bytes], { type: "application/pdf" }),
      folderId: null,
    });
    libStatus.textContent = "PDF added to Library.";
    await renderLibrary();
  } catch {
    libStatus.textContent = "Couldn't upload this file.";
  }
});

switchTab("library");
