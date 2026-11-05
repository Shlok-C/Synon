import type { LibraryFolder, LibraryItem } from "./types";
import { MSG_GET_ARTICLE_SNAPSHOT, type ArticleSnapshotResponse, type GetArticleSnapshotMessage } from "./messages";
import { getOriginalPdfUrlFromViewerUrl } from "./pdf-viewer-url";

const DB_NAME = "synon-library";
const DB_VERSION = 2;
const ITEMS_STORE = "items";
const FOLDERS_STORE = "folders";
const OUTLINE_CACHE_STORE = "outlineCache";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ITEMS_STORE)) {
        const items = db.createObjectStore(ITEMS_STORE, { keyPath: "id" });
        items.createIndex("folderId", "folderId");
      }
      if (!db.objectStoreNames.contains(FOLDERS_STORE)) {
        db.createObjectStore(FOLDERS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(OUTLINE_CACHE_STORE)) {
        db.createObjectStore(OUTLINE_CACHE_STORE, { keyPath: "pdfKey" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function newId(): string {
  return crypto.randomUUID();
}

export async function addItem(
  item: Omit<LibraryItem, "id" | "dateAdded">
): Promise<LibraryItem> {
  const db = await openDb();
  const full: LibraryItem = { ...item, id: newId(), dateAdded: Date.now() };
  const store = db.transaction(ITEMS_STORE, "readwrite").objectStore(ITEMS_STORE);
  await promisifyRequest(store.add(full));
  return full;
}

// Saves a browser tab into the Library: a PDF (if the tab is the Synon
// viewer showing one) or an article snapshot otherwise. Caller validates
// tab.id/tab.url are present first — behavior on a missing tab differs per
// call site (silent no-op from the context menu vs. a status message in the
// popup), so this assumes both are already known-good.
export async function addTabToLibrary(tab: {
  id: number;
  url: string;
  title?: string;
  favIconUrl?: string;
}): Promise<void> {
  const originalPdfUrl = getOriginalPdfUrlFromViewerUrl(tab.url);
  if (originalPdfUrl) {
    await addItem({
      type: "pdf",
      sourceKind: "public",
      url: originalPdfUrl,
      title: tab.title || originalPdfUrl,
      faviconUrl: tab.favIconUrl ?? null,
      snapshotText: null,
      pdfBytes: null,
      folderId: null,
    });
    return;
  }

  const getSnapshotMessage: GetArticleSnapshotMessage = { type: MSG_GET_ARTICLE_SNAPSHOT };
  const snapshot = (await chrome.tabs
    .sendMessage(tab.id, getSnapshotMessage)
    .catch(() => null)) as ArticleSnapshotResponse | null;

  await addItem({
    type: "article",
    sourceKind: "public",
    url: tab.url,
    title: snapshot?.title || tab.title || tab.url,
    faviconUrl: snapshot?.faviconUrl ?? tab.favIconUrl ?? null,
    snapshotText: snapshot?.text ?? null,
    pdfBytes: null,
    folderId: null,
  });
}

export async function listItems(
  folderId?: string | null
): Promise<LibraryItem[]> {
  const db = await openDb();
  const store = db.transaction(ITEMS_STORE, "readonly").objectStore(ITEMS_STORE);
  const all = await promisifyRequest(store.getAll());
  if (folderId === undefined) return all;
  return all.filter((i) => i.folderId === folderId);
}

export async function deleteItem(id: string): Promise<void> {
  const db = await openDb();
  const store = db.transaction(ITEMS_STORE, "readwrite").objectStore(ITEMS_STORE);
  await promisifyRequest(store.delete(id));
}

export async function moveItemToFolder(
  id: string,
  folderId: string | null
): Promise<void> {
  const db = await openDb();
  const store = db.transaction(ITEMS_STORE, "readwrite").objectStore(ITEMS_STORE);
  const item = await promisifyRequest(store.get(id));
  if (!item) return;
  item.folderId = folderId;
  await promisifyRequest(store.put(item));
}

export async function renameItem(id: string, title: string): Promise<void> {
  const db = await openDb();
  const store = db.transaction(ITEMS_STORE, "readwrite").objectStore(ITEMS_STORE);
  const item = await promisifyRequest(store.get(id));
  if (!item) return;
  item.title = title;
  await promisifyRequest(store.put(item));
}

export async function createFolder(name: string): Promise<LibraryFolder> {
  const db = await openDb();
  const existing = await listFolders();
  const folder: LibraryFolder = { id: newId(), name, createdAt: Date.now(), order: existing.length };
  const store = db.transaction(FOLDERS_STORE, "readwrite").objectStore(FOLDERS_STORE);
  await promisifyRequest(store.add(folder));
  return folder;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const db = await openDb();
  const store = db.transaction(FOLDERS_STORE, "readwrite").objectStore(FOLDERS_STORE);
  const folder = await promisifyRequest(store.get(id));
  if (!folder) return;
  folder.name = name;
  await promisifyRequest(store.put(folder));
}

export async function deleteFolder(id: string): Promise<void> {
  const db = await openDb();

  const itemsStore = db.transaction(ITEMS_STORE, "readwrite").objectStore(ITEMS_STORE);
  const items: LibraryItem[] = await promisifyRequest(
    itemsStore.index("folderId").getAll(id)
  );
  for (const item of items) {
    item.folderId = null;
    await promisifyRequest(itemsStore.put(item));
  }

  const foldersStore = db.transaction(FOLDERS_STORE, "readwrite").objectStore(FOLDERS_STORE);
  await promisifyRequest(foldersStore.delete(id));
}

export async function listFolders(): Promise<LibraryFolder[]> {
  const db = await openDb();
  const store = db.transaction(FOLDERS_STORE, "readonly").objectStore(FOLDERS_STORE);
  const all = await promisifyRequest(store.getAll());
  return all.sort((a, b) => a.order - b.order);
}

export async function moveFolderOrder(id: string, direction: "up" | "down"): Promise<void> {
  const db = await openDb();
  const ordered = await listFolders();
  const index = ordered.findIndex((f) => f.id === id);
  if (index === -1) return;

  const neighborIndex = direction === "up" ? index - 1 : index + 1;
  if (neighborIndex < 0 || neighborIndex >= ordered.length) return;

  const current = ordered[index];
  const neighbor = ordered[neighborIndex];
  const swap = current.order;
  current.order = neighbor.order;
  neighbor.order = swap;

  const store = db.transaction(FOLDERS_STORE, "readwrite").objectStore(FOLDERS_STORE);
  await promisifyRequest(store.put(current));
  await promisifyRequest(store.put(neighbor));
}
