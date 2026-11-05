// The definition pipeline: classify → Exact Mode gate → lexicon gate →
// Wiktionary + Wikipedia → lemma fallback → AI fallback → LLM reorder.
// See CLAUDE.md "Definition pipeline" for the full description.
import { isCommonWord } from "../common-words";
import { noun, verb, adjective } from "wink-lemmatizer";
import lexicon from "wink-lexicon/src/wn-words.js";
import type { Definition, DefineResponse, PopupSchema, PageKind, SelectionType } from "../shared/types";
import { classify } from "../shared/validation";
import { lookupWiktionary, lookupWikipedia, type DictionaryResult, type SourceResult, type WikiSummary } from "./sources";
import { getApiKey, lookupAI, pickBestDefinition } from "./openrouter";

// Hard ceiling for one define request. The content script waits 25s
// (see DEFINE_TIMEOUT_MS in content/index.ts), so the background always answers first.
// Worst case is the AI path: primary ≤7s + lemmas ≤4s + AI ≤9s.
const DEFINE_BUDGET_MS = 20000;
const AI_TIMEOUT_MS = 9000;
const REORDER_TIMEOUT_MS = 4000;
// Don't start an LLM call with less than this left — it couldn't finish anyway.
const MIN_LLM_WINDOW_MS = 1000;

// --- Caches ---
// Two layers:
//  1. definitionCache — whole responses keyed by text + settings + page context.
//     In-memory only: a fast path for reselecting the same word in the same place.
//  2. The source cache — each source's raw result keyed by word alone, plus the
//     LLM reorder pick keyed by word + context. Memory first, written through to
//     chrome.storage.session so it survives the service worker being killed
//     (~30s idle) and is shared across pages/paragraphs. Only definitive results
//     are stored (SourceResult.cacheable) — never a 429/5xx/timeout outcome.
interface CacheEntry {
  response: DefineResponse;
  timestamp: number;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX = 200;
const definitionCache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<DefineResponse>>();

const SOURCE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const SOURCE_MEMORY_MAX = 500;

interface StoredValue {
  value: unknown;
  timestamp: number;
}

const sourceMemory = new Map<string, StoredValue>();

function isFresh(entry: StoredValue | undefined): entry is StoredValue {
  return !!entry && Date.now() - entry.timestamp <= SOURCE_CACHE_TTL;
}

function rememberInMemory(key: string, entry: StoredValue): void {
  if (sourceMemory.size >= SOURCE_MEMORY_MAX) sourceMemory.delete(sourceMemory.keys().next().value!);
  sourceMemory.set(key, entry);
}

// `undefined` = miss. A cached `null` (e.g. "no dictionary entry") is a hit.
async function readStored<T>(key: string): Promise<T | undefined> {
  const mem = sourceMemory.get(key);
  if (isFresh(mem)) return mem.value as T;
  try {
    const stored = (await chrome.storage.session.get(key))[key] as StoredValue | undefined;
    if (isFresh(stored)) {
      rememberInMemory(key, stored);
      return stored.value as T;
    }
  } catch {
    // storage.session unavailable — memory-only caching still works.
  }
  return undefined;
}

function writeStored(key: string, value: unknown): void {
  const entry: StoredValue = { value, timestamp: Date.now() };
  rememberInMemory(key, entry);
  chrome.storage.session.set({ [key]: entry }).catch(() => {
    // Quota (10MB) exhausted: start over rather than evicting piecemeal.
    chrome.storage.session.clear().catch(() => {});
  });
}

// Drops every in-memory cache — what a service-worker restart does. The
// storage.session layer is untouched. Exported for the replay test harness.
export function clearMemoryCaches(): void {
  definitionCache.clear();
  sourceMemory.clear();
}

function hashContext(context: string): string {
  const slice = context.slice(0, 1000);
  let h = 5381;
  for (let i = 0; i < slice.length; i++) h = ((h << 5) + h + slice.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function getCacheKey(text: string, exactMode: boolean, verbosity: number, pageContext: string): string {
  return text.toLowerCase() + "|" + (exactMode ? "1" : "0") + "|v" + verbosity + "|c" + hashContext(pageContext);
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

// --- Lexicon + lemmatization ---
function isInLexicon(word: string): boolean {
  return lexicon[word.toLowerCase()] !== undefined;
}

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

function countSources(defs: Definition[]): { dictionary: number; wikipedia: number; ai: number } {
  const counts = { dictionary: 0, wikipedia: 0, ai: 0 };
  for (const d of defs) {
    switch (d.source) {
      case "Dictionary": counts.dictionary++; break;
      case "Wikipedia": counts.wikipedia++; break;
      case "AI": counts.ai++; break;
    }
  }
  return counts;
}

function toDefinitions(
  dict: DictionaryResult | null,
  wiki: WikiSummary[],
  verbosity: number,
  rootWord?: string
): Definition[] {
  const root = rootWord ? { rootWord } : {};
  const definitions: Definition[] = [];
  if (dict) definitions.push({ source: "Dictionary", text: dict.text, url: dict.url, ...root });
  for (const w of wiki) {
    definitions.push({ source: "Wikipedia", text: truncateByVerbosity(w.text, verbosity), url: w.url, title: w.title, ...root });
  }
  return definitions;
}

// --- Per-request source isolation ---
type TransportFailure = "TIMEOUT" | "NETWORK";

const FAILURE_MESSAGES: Record<TransportFailure, string> = {
  TIMEOUT: "Request timed out. Please try again.",
  NETWORK: "Network error. Check your connection.",
};

// Runs each lookup so that a timeout/network error yields `fallback` instead of
// rejecting the whole request — one slow source must never discard another's
// results. Records the failures so the request can still report a transport
// error when *every* source failed. API_KEY_INVALID is rethrown (it's actionable).
function createSourceTracker() {
  let attempts = 0;
  let degraded = false;
  const failures: TransportFailure[] = [];
  return {
    async run<T>(lookup: Promise<T>, fallback: T): Promise<T> {
      attempts++;
      try {
        return await lookup;
      } catch (err) {
        const msg = (err as Error | null)?.message;
        if (msg === "API_KEY_INVALID") throw err;
        degraded = true;
        if (msg === "TIMEOUT" || msg === "NETWORK") failures.push(msg);
        else console.error("Synon lookup error:", err);
        return fallback;
      }
    },
    // A source lookup served from the source cache when possible; a fresh,
    // definitive result is written back. A non-definitive one (429/5xx) marks
    // the request degraded so its assembled response isn't cached either.
    cached<T>(key: string, lookup: () => Promise<SourceResult<T>>, fallback: T): Promise<T> {
      return this.run((async () => {
        const hit = await readStored<T>(key);
        if (hit !== undefined) return hit;
        const res = await lookup();
        if (res.cacheable) writeStored(key, res.value);
        else degraded = true;
        return res.value;
      })(), fallback);
    },
    // True if any source failed or returned a non-definitive answer.
    get degraded(): boolean {
      return degraded;
    },
    // The transport failure to report, if every source attempted so far failed.
    allFailedWith(): TransportFailure | null {
      return attempts > 0 && failures.length === attempts ? failures[0] : null;
    },
  };
}
type SourceTracker = ReturnType<typeof createSourceTracker>;

// Source-cache keys use the exact selection text: both Wiktionary and
// Wikipedia titles are case-sensitive beyond the first letter ("US" ≠ "us").
function wiktionary(tracker: SourceTracker, word: string): Promise<DictionaryResult | null> {
  return tracker.cached(`src:wiktionary:${word}`, () => lookupWiktionary(word), null);
}

function wikipedia(tracker: SourceTracker, text: string, expand: boolean): Promise<WikiSummary[]> {
  return tracker.cached(`src:wikipedia${expand ? "" : "-lite"}:${text}`, () => lookupWikipedia(text, { expand }), []);
}

// --- Pipeline stages ---

// Lexicon gate: an unrecognized single word (and none of its lemmas are
// recognized either) only gets a dictionary check — no Wikipedia/AI.
// Returns a dictionary-only lookup result, or null to continue the full pipeline.
async function runLexiconGate(
  type: SelectionType,
  selectedText: string,
  tracker: SourceTracker
): Promise<{ definitions: Definition[] } | null> {
  if (type !== "word" || isInLexicon(selectedText)) return null;
  if (lemmatize(selectedText).some((l) => isInLexicon(l))) return null;

  const dict = await wiktionary(tracker, selectedText);
  return { definitions: toDefinitions(dict, [], 0) };
}

// Dictionary + Wikipedia in parallel, each isolated. Whichever answers first
// with something is streamed out via onPartial (emitPartial drops empty/repeat lists) (Wiktionary typically lands in
// ~0.1–0.4s, well before Wikipedia's disambiguation expansion finishes).
async function fetchPrimaryDefinitions(
  selectedText: string,
  verbosity: number,
  tracker: SourceTracker,
  onPartial: (defs: Definition[]) => void
): Promise<Definition[]> {
  let dict: DictionaryResult | null = null;
  let wiki: WikiSummary[] = [];
  const emit = () => onPartial(toDefinitions(dict, wiki, verbosity));
  await Promise.all([
    wiktionary(tracker, selectedText).then((d) => { dict = d; emit(); }),
    wikipedia(tracker, selectedText, true).then((w) => { wiki = w; emit(); }),
  ]);
  return toDefinitions(dict, wiki, verbosity);
}

// All lemma root forms are looked up in parallel (no disambiguation expansion,
// to stay inside the budget); the first lemma in order that yields anything wins.
async function tryLemmaFallback(selectedText: string, verbosity: number, tracker: SourceTracker): Promise<Definition[]> {
  const perLemma = await Promise.all(lemmatize(selectedText).map(async (lemma) => {
    const [dict, wiki] = await Promise.all([
      wiktionary(tracker, lemma),
      wikipedia(tracker, lemma, false),
    ]);
    return toDefinitions(dict, wiki, verbosity, lemma);
  }));
  return perLemma.find((defs) => defs.length > 0) ?? [];
}

// Context-based reordering: asks the LLM which candidate best matches the
// page's topic and moves it to index 0. Mutates `definitions` in place;
// returns whether a reorder happened. Any failure (rate-limit, timeout, bad
// key) leaves the original ordering untouched.
// The pick is cached per word + context + candidate list, so revisiting the
// same passage (or a worker restart) doesn't repeat the LLM call.
async function applyContextReorder(
  selectedText: string,
  pageContext: string,
  definitions: Definition[],
  apiKey: string,
  timeoutMs: number
): Promise<boolean> {
  try {
    const candidates = hashContext(definitions.map((d) => `${d.source}:${d.title ?? ""}:${d.text.slice(0, 40)}`).join("|"));
    const key = `reorder:${selectedText}|${hashContext(pageContext)}|${candidates}`;
    let pick = await readStored<number | null>(key);
    if (pick === undefined) {
      pick = await pickBestDefinition(selectedText, pageContext, definitions, apiKey, timeoutMs);
      if (pick !== null) writeStored(key, pick);
    }
    if (pick === null || pick <= 0 || pick >= definitions.length) return false;
    const [chosen] = definitions.splice(pick, 1);
    definitions.unshift(chosen);
    return true;
  } catch {
    return false;
  }
}

// --- Entry point ---
// `onPartial` receives interim, non-empty definition lists before the final
// response (see Progressive display in CLAUDE.md). A caller that joins an
// already in-flight request for the same key only gets the final response.
export async function handleDefine(
  selectedText: string,
  pageContext: string,
  exactMode: boolean = false,
  verbosity: number = 3,
  pageKind: PageKind = "generic",
  onPartial: (defs: Definition[]) => void = () => {}
): Promise<DefineResponse> {
  const cacheKey = getCacheKey(selectedText, exactMode, verbosity, pageContext);
  const cached = getCached(cacheKey);
  if (cached) {
    return cached.schema
      ? { ...cached, schema: { ...cached.schema, result: { ...cached.schema.result, fromCache: true } } }
      : cached;
  }

  const existing = inFlightRequests.get(cacheKey);
  if (existing) return existing;

  const promise = handleDefineInner(selectedText, pageContext, exactMode, verbosity, pageKind, cacheKey, onPartial);
  inFlightRequests.set(cacheKey, promise);
  promise.finally(() => inFlightRequests.delete(cacheKey));
  return promise;
}

async function handleDefineInner(
  selectedText: string,
  pageContext: string,
  exactMode: boolean,
  verbosity: number,
  pageKind: PageKind,
  cacheKey: string,
  onPartial: (defs: Definition[]) => void
): Promise<DefineResponse> {
  const deadline = Date.now() + DEFINE_BUDGET_MS;
  const remaining = () => Math.max(0, deadline - Date.now());

  const type = classify(selectedText);
  if (type === "invalid") {
    return { definitions: [], error: "Please select a valid word or phrase." };
  }

  // --- Per-highlight schema scaffolding ---
  const words = selectedText.trim().split(/\s+/);
  const common = type === "word" ? isCommonWord(selectedText) : words.some((w) => isCommonWord(w));
  const baseSchema = {
    phrase: selectedText,
    selectionType: type,
    wordCount: words.length,
    common,
    inLexicon: type === "word" ? isInLexicon(selectedText) : false,
    context: { length: pageContext.length, pageKind },
    settings: { exactMode, verbosity },
  };

  let usedLemmaFallback = false;
  let usedAiFallback = false;
  let reorderedByLLM = false;
  const chosenIndex = 0; // definitions[0] is always the chosen one by construction

  const makeSchema = (
    defs: Definition[],
    extra: { skipped?: boolean; error?: string | null } = {}
  ): PopupSchema => ({
    ...baseSchema,
    result: {
      skipped: extra.skipped ?? false,
      fromCache: false,
      definitionCount: defs.length,
      sourceCounts: countSources(defs),
      wikipediaPages: defs.filter((d) => d.source === "Wikipedia").map((d) => d.title ?? "").filter(Boolean),
      usedLemmaFallback,
      usedAiFallback,
      reorderedByLLM,
      chosenIndex,
      error: extra.error ?? null,
    },
  });

  const errorResponse = (error: string): DefineResponse =>
    ({ definitions: [], error, schema: makeSchema([], { error }) });
  const skipResponse = (): DefineResponse =>
    ({ definitions: [], skip: true, schema: makeSchema([], { skipped: true }) });
  const tracker = createSourceTracker();
  const successResponse = (definitions: Definition[]): DefineResponse => {
    const response: DefineResponse = { definitions, schema: makeSchema(definitions) };
    // A response assembled from a failed/rate-limited source is incomplete — don't pin it.
    if (!tracker.degraded) setCache(cacheKey, response);
    return response;
  };

  // Streams interim results; never empty (quiet mode must still see a real
  // empty/failed final response) and never a repeat of the last emission.
  let lastPartialCount = 0;
  const emitPartial = (defs: Definition[]) => {
    if (defs.length === 0 || defs.length === lastPartialCount) return;
    lastPartialCount = defs.length;
    onPartial(defs.slice());
  };

  // Exact Mode off: skip common words/phrases (`common` covers both word and phrase cases).
  if (!exactMode && common) return skipResponse();

  try {
    // Resolved once: gates both LLM stages, and AI must only count as an
    // attempted source when it can actually run (see allFailedWith).
    const apiKey = await getApiKey();

    const gated = await runLexiconGate(type, selectedText, tracker);
    if (gated) {
      if (gated.definitions.length > 0) return successResponse(gated.definitions);
      const failure = tracker.allFailedWith();
      return failure ? errorResponse(FAILURE_MESSAGES[failure]) : skipResponse();
    }

    const definitions = await fetchPrimaryDefinitions(selectedText, verbosity, tracker, emitPartial);

    if (definitions.length === 0 && type === "word") {
      const lemmaDefinitions = await tryLemmaFallback(selectedText, verbosity, tracker);
      if (lemmaDefinitions.length > 0) {
        definitions.push(...lemmaDefinitions);
        usedLemmaFallback = true;
      }
    }

    if (definitions.length === 0 && apiKey && remaining() >= MIN_LLM_WINDOW_MS) {
      const aiResult = await tracker.run(
        lookupAI(selectedText, pageContext, apiKey, Math.min(AI_TIMEOUT_MS, remaining())),
        null
      );
      if (aiResult) {
        definitions.push({ source: "AI", text: aiResult, url: null });
        usedAiFallback = true;
      }
    }

    if (definitions.length === 0) {
      const failure = tracker.allFailedWith();
      if (failure) return errorResponse(FAILURE_MESSAGES[failure]);
      return errorResponse(apiKey
        ? "No definition found."
        : "No definition found, and no OpenRouter API key set for AI fallback. Click the Synon icon to add one.");
    }

    if (definitions.length >= 2 && pageContext.trim().length >= 50 && apiKey && remaining() >= MIN_LLM_WINDOW_MS) {
      // Show every meaning while the LLM decides which fits the page best.
      emitPartial(definitions);
      reorderedByLLM = await applyContextReorder(
        selectedText, pageContext, definitions, apiKey, Math.min(REORDER_TIMEOUT_MS, remaining())
      );
    }

    return successResponse(definitions);
  } catch (err) {
    if ((err as Error | null)?.message === "API_KEY_INVALID") {
      return errorResponse("API key is invalid or expired. Update it in Synon settings.");
    }
    console.error("Synon define error:", err);
    return errorResponse("Something went wrong.");
  }
}
