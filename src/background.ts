import { isCommonWord } from "./common-words";
import { noun, verb, adjective } from "wink-lemmatizer";
import type { Definition, DefineResponse } from "./shared/types";
import { classify } from "./shared/validation";
import { MSG_DEFINE, MSG_SHOW_DEFINITION, MSG_PDF_DETECTED } from "./shared/messages";

// --- Definition cache ---
interface CacheEntry {
  response: DefineResponse;
  timestamp: number;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX = 200;
const definitionCache = new Map<string, CacheEntry>();

function getCacheKey(text: string, exactMode: boolean): string {
  return text.toLowerCase() + "|" + (exactMode ? "1" : "0");
}

function getCached(key: string): DefineResponse | null {
  const entry = definitionCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    definitionCache.delete(key);
    return null;
  }
  return entry.response;
}

function setCache(key: string, response: DefineResponse): void {
  // Evict oldest entries if at capacity
  if (definitionCache.size >= CACHE_MAX) {
    const firstKey = definitionCache.keys().next().value!;
    definitionCache.delete(firstKey);
  }
  definitionCache.set(key, { response, timestamp: Date.now() });
}

// --- Lemmatization ---
function lemmatize(word: string): string[] {
  const lower = word.toLowerCase();
  const results = new Set<string>();
  for (const fn of [noun, verb, adjective]) {
    const lemma = fn(lower);
    if (lemma && lemma !== lower) results.add(lemma);
  }
  return Array.from(results);
}

// --- Lookup functions ---
async function lookupDictionary(word: string): Promise<{ text: string; url: string } | null> {
  try {
    const resp = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`
    );
    if (!resp.ok) return null;

    const data = await resp.json();
    const entry = data?.[0];
    if (!entry?.meanings?.length) return null;

    const lines: string[] = [];
    for (const meaning of entry.meanings) {
      const pos = meaning.partOfSpeech;
      const def = meaning.definitions?.[0]?.definition;
      if (pos && def) {
        lines.push(`(${pos}) ${def}`);
      }
    }
    if (lines.length === 0) return null;

    const url = entry.sourceUrls?.[0] || `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`;
    return { text: lines.join("\n"), url };
  } catch {
    return null;
  }
}

async function lookupWikipedia(text: string): Promise<{ text: string; url: string } | null> {
  try {
    const resp = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(text)}`
    );
    if (!resp.ok) return null;

    const data = await resp.json();

    if (data.type === "disambiguation") return null;

    const extract = data.extract?.trim();
    if (!extract || extract.length <= 10) return null;

    const url = data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(text)}`;
    return { text: extract, url };
  } catch {
    return null;
  }
}

async function lookupAI(
  selectedText: string,
  pageContext: string
): Promise<string | null> {
  const apiKey = await getApiKey();
  if (!apiKey) return null;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: pageContext && pageContext.length > 50
              ? `Define "${selectedText}" in the context of this page:\n\n${pageContext}`
              : `Define "${selectedText}" concisely. Provide the most common meaning.`,
          },
        ],
      }),
    });

    const data = await response.json();
    const text = data?.content?.[0]?.text;
    return text || null;
  } catch (err) {
    console.error("Synon API error:", err);
    return null;
  }
}

// --- PDF detection helpers ---
function isPdfUrl(url: string): boolean {
  try { return new URL(url).pathname.toLowerCase().endsWith(".pdf"); }
  catch { return false; }
}

function getViewerUrl(pdfUrl: string): string {
  return `${chrome.runtime.getURL("pdfjs/web/viewer.html")}?file=${encodeURIComponent(pdfUrl)}`;
}

// URL-based PDF detection (catches .pdf links before navigation completes)
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!isPdfUrl(details.url)) return;
  if (details.url.startsWith(chrome.runtime.getURL(""))) return;
  chrome.tabs.update(details.tabId, { url: getViewerUrl(details.url) });
});

// --- Context menu ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "synon-define",
    title: 'Define "%s"',
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "synon-define" || !info.selectionText) return;

  const selectedText = info.selectionText.trim();
  if (!selectedText) return;

  const result = await handleDefine(selectedText, "", true);

  if (tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: MSG_SHOW_DEFINITION,
        selectedText,
        definitions: result.definitions,
        error: result.error,
      });
    } catch {
      // Content script not available — no popup possible
    }
  }
});

// --- Message handling ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === MSG_DEFINE) {
    const { selectedText, pageContext, exactMode } = message as {
      selectedText: string;
      pageContext: string;
      exactMode?: boolean;
    };
    handleDefine(selectedText, pageContext, exactMode ?? false).then(sendResponse);
    return true;
  }

  // Embed-based PDF detection (catches PDFs served without .pdf extension)
  if (message.type === MSG_PDF_DETECTED) {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      chrome.tabs.update(tabId, { url: getViewerUrl(message.url) });
    }
    return false;
  }

  return false;
});

// --- Core define handler ---
async function handleDefine(
  selectedText: string,
  pageContext: string,
  exactMode: boolean = false
): Promise<DefineResponse> {
  // Check cache first
  const cacheKey = getCacheKey(selectedText, exactMode);
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const type = classify(selectedText);
  if (type === "invalid") {
    return { definitions: [], error: "Please select a valid word or phrase." };
  }

  if (!exactMode) {
    if (type === "word" && isCommonWord(selectedText)) {
      return { definitions: [], skip: true };
    }
    if (type === "phrase") {
      const words = selectedText.trim().split(/\s+/);
      if (words.some((w) => isCommonWord(w))) {
        return { definitions: [], skip: true };
      }
    }
  }

  const [dictResult, wikiResult] = await Promise.all([
    lookupDictionary(selectedText),
    lookupWikipedia(selectedText),
  ]);

  const definitions: Definition[] = [];
  if (dictResult) definitions.push({ source: "Dictionary", text: dictResult.text, url: dictResult.url });
  if (wikiResult) definitions.push({ source: "Wikipedia", text: wikiResult.text, url: wikiResult.url });

  if (definitions.length === 0 && type === "word") {
    const lemmas = lemmatize(selectedText);
    for (const lemma of lemmas) {
      const [lemmaDict, lemmaWiki] = await Promise.all([
        lookupDictionary(lemma),
        lookupWikipedia(lemma),
      ]);
      if (lemmaDict) definitions.push({ source: "Dictionary", text: lemmaDict.text, url: lemmaDict.url, rootWord: lemma });
      if (lemmaWiki) definitions.push({ source: "Wikipedia", text: lemmaWiki.text, url: lemmaWiki.url, rootWord: lemma });
      if (definitions.length > 0) break;
    }
  }

  if (definitions.length === 0) {
    const aiResult = await lookupAI(selectedText, pageContext);
    if (aiResult) {
      definitions.push({ source: "AI", text: aiResult, url: null });
    }
  }

  if (definitions.length === 0) {
    const hasKey = !!(await getApiKey());
    return {
      definitions: [],
      error: hasKey
        ? "No definition found."
        : "No definition found, and no API key set for AI fallback. Click the Synon icon to add one.",
    };
  }

  const response: DefineResponse = { definitions };
  setCache(cacheKey, response);
  return response;
}

async function getApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.sync.get("apiKey", (result) => {
      resolve(result.apiKey ?? null);
    });
  });
}
