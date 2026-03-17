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

function getCacheKey(text: string, exactMode: boolean, verbosity: number): string {
  return text.toLowerCase() + "|" + (exactMode ? "1" : "0") + "|v" + verbosity;
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

// --- Verbosity truncation ---
const VERBOSITY_SENTENCE_MAP: Record<number, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 5,
  5: Infinity,
};

function truncateByVerbosity(text: string, verbosity: number): string {
  const maxSentences = VERBOSITY_SENTENCE_MAP[verbosity] ?? 3;
  if (maxSentences === Infinity) return text;

  // Split on sentence boundaries: period/!/? followed by space and uppercase letter, or end of string
  const sentences = text.match(/[^.!?]*[.!?]+(?:\s|$)/g);
  if (!sentences) return text;

  const truncated = sentences.slice(0, maxSentences).join("").trim();
  return truncated || text;
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

const WIKI_DISAMBIG_MAX = 5;

async function fetchWikiSummary(title: string): Promise<{ title: string; text: string; url: string } | null> {
  try {
    const resp = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.type === "disambiguation") return null;
    const extract = data.extract?.trim();
    if (!extract || extract.length <= 10) return null;
    const url = data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
    return { title: data.title || title, text: extract, url };
  } catch {
    return null;
  }
}

async function fetchDisambiguationEntries(title: string): Promise<string[]> {
  try {
    // Try section 0 first (the "most commonly refers to" entries)
    const resp = await fetch(
      `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&section=0&format=json&origin=*`
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    const wikitext: string = data?.parse?.wikitext?.["*"] || "";
    let links = parseWikitextLinks(wikitext);

    // If section 0 has no article links, try sections 1-3
    if (links.length === 0) {
      const sectionLinks: string[] = [];
      for (let s = 1; s <= 3; s++) {
        const sResp = await fetch(
          `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&section=${s}&format=json&origin=*`
        );
        if (!sResp.ok) break;
        const sData = await sResp.json();
        const sWikitext: string = sData?.parse?.wikitext?.["*"] || "";
        sectionLinks.push(...parseWikitextLinks(sWikitext));
        if (sectionLinks.length >= WIKI_DISAMBIG_MAX) break;
      }
      links = sectionLinks;
    }

    return links.slice(0, WIKI_DISAMBIG_MAX);
  } catch {
    return [];
  }
}

function parseWikitextLinks(wikitext: string): string[] {
  const linkRegex = /\[\[([^|\]]+?)(?:\|[^\]]+?)?\]\]/;
  const links: string[] = [];
  for (const line of wikitext.split("\n")) {
    const trimmed = line.trimStart();
    // Only consider top-level bullets (starts with * but not **)
    if (!trimmed.startsWith("*") || trimmed.startsWith("**")) continue;
    const match = linkRegex.exec(trimmed);
    if (!match) continue;
    const target = match[1].trim();
    // Skip non-article links
    if (target.startsWith("wikt:") || target.startsWith("Category:") ||
        target.startsWith("File:") || target.startsWith("Help:") ||
        target.startsWith("Wikipedia:")) continue;
    if (!links.includes(target)) links.push(target);
  }
  return links;
}

async function lookupWikipedia(text: string): Promise<{ title: string; text: string; url: string }[]> {
  try {
    const resp = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(text)}`
    );
    if (!resp.ok) return [];

    const data = await resp.json();

    // Disambiguation page: fetch top entries
    if (data.type === "disambiguation") {
      const entries = await fetchDisambiguationEntries(text);
      if (entries.length === 0) return [];
      const results = await Promise.all(entries.map(fetchWikiSummary));
      const filtered = results.filter((r): r is { title: string; text: string; url: string } => r !== null);
      // Deduplicate by resolved title (redirects can map multiple entries to the same article)
      const seen = new Set<string>();
      return filtered.filter(r => {
        if (seen.has(r.title)) return false;
        seen.add(r.title);
        return true;
      });
    }

    // Normal page — also check for a separate disambiguation page
    const extract = data.extract?.trim();
    if (!extract || extract.length <= 10) return [];
    const url = data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(text)}`;
    const primary = { title: data.title || text, text: extract, url };

    // Try to find additional meanings from a _(disambiguation) page
    const disambigEntries = await fetchDisambiguationEntries(`${text}_(disambiguation)`);
    if (disambigEntries.length === 0) return [primary];

    const disambigResults = await Promise.all(disambigEntries.map(fetchWikiSummary));
    const filtered = disambigResults.filter(
      (r): r is { title: string; text: string; url: string } => r !== null
    );
    const seen = new Set<string>([primary.title]);
    const additional = filtered.filter(r => {
      if (seen.has(r.title)) return false;
      seen.add(r.title);
      return true;
    });
    return [primary, ...additional].slice(0, WIKI_DISAMBIG_MAX);
  } catch {
    return [];
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
  chrome.storage.sync.get("pdfViewerEnabled", (result) => {
    if (result.pdfViewerEnabled === false) return;
    chrome.tabs.update(details.tabId, { url: getViewerUrl(details.url) });
  });
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
    const { selectedText, pageContext, exactMode, verbosity } = message as {
      selectedText: string;
      pageContext: string;
      exactMode?: boolean;
      verbosity?: number;
    };
    handleDefine(selectedText, pageContext, exactMode ?? false, verbosity ?? 3).then(sendResponse);
    return true;
  }

  // Embed-based PDF detection (catches PDFs served without .pdf extension)
  if (message.type === MSG_PDF_DETECTED) {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      chrome.storage.sync.get("pdfViewerEnabled", (result) => {
        if (result.pdfViewerEnabled === false) return;
        chrome.tabs.update(tabId, { url: getViewerUrl(message.url) });
      });
    }
    return false;
  }

  return false;
});

// --- Core define handler ---
async function handleDefine(
  selectedText: string,
  pageContext: string,
  exactMode: boolean = false,
  verbosity: number = 3
): Promise<DefineResponse> {
  // Check cache first
  const cacheKey = getCacheKey(selectedText, exactMode, verbosity);
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

  const [dictResult, wikiResults] = await Promise.all([
    lookupDictionary(selectedText),
    lookupWikipedia(selectedText),
  ]);

  const definitions: Definition[] = [];

  // Deduplicate: drop dictionary if Wikipedia has a direct (non-disambiguation) article match
  const hasDirectWikiMatch = wikiResults.some(
    (wr) => wr.title.toLowerCase() === selectedText.toLowerCase()
  );
  if (dictResult && !hasDirectWikiMatch) {
    definitions.push({ source: "Dictionary", text: dictResult.text, url: dictResult.url });
  }
  for (const wr of wikiResults) {
    definitions.push({ source: "Wikipedia", text: truncateByVerbosity(wr.text, verbosity), url: wr.url, title: wr.title });
  }

  if (definitions.length === 0 && type === "word") {
    const lemmas = lemmatize(selectedText);
    for (const lemma of lemmas) {
      const [lemmaDict, lemmaWiki] = await Promise.all([
        lookupDictionary(lemma),
        lookupWikipedia(lemma),
      ]);
      if (lemmaDict) definitions.push({ source: "Dictionary", text: lemmaDict.text, url: lemmaDict.url, rootWord: lemma });
      for (const lw of lemmaWiki) {
        definitions.push({ source: "Wikipedia", text: truncateByVerbosity(lw.text, verbosity), url: lw.url, rootWord: lemma, title: lw.title });
      }
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
