// Network lookups for the definition pipeline: Wiktionary (dictionary) and
// Wikipedia (encyclopedia), plus the fetch/timeout helpers they share with
// openrouter.ts.
//
// Lookups resolve to null/[] on a genuine miss and throw Error("TIMEOUT") /
// Error("NETWORK") on a transport failure — define.ts isolates each source so
// one failing never discards another's results.

export const SOURCE_TIMEOUT_MS = 4000;
// Shared budget for expanding a Wikipedia disambiguation page (section fetches
// + candidate summaries). On expiry the primary article is kept on its own.
const DISAMBIG_BUDGET_MS = 3000;
// Per-candidate cap: one slow article is dropped instead of holding up the rest
// (a measured candidate summary took 2.3s while its siblings took ~60ms).
const CANDIDATE_TIMEOUT_MS = 1000;
const WIKI_DISAMBIG_MAX = 5;
// Wikimedia asks API clients to identify themselves; browsers can't override
// User-Agent, so this is their documented alternative. Unidentified clients are
// rate-limited (HTTP 429) far more aggressively.
const WIKIMEDIA_INIT: RequestInit = { headers: { "Api-User-Agent": "Synon/1.0 (Chrome extension; definition popup)" } };

// Maps a fetch-layer failure to the sentinel Error the rest of the pipeline
// switches on, or null if the error isn't one of those.
export function classifyFetchError(err: unknown): Error | null {
  if ((err as { name?: string } | null)?.name === "AbortError") return new Error("TIMEOUT");
  if (err instanceof TypeError) return new Error("NETWORK");
  return null;
}

export interface JsonResponse {
  ok: boolean;
  status: number;
  data: any;
}

// fetch + JSON parse under a single timeout. The timer stays armed through the
// body read — a server that sends headers promptly but stalls the body
// (OpenRouter pads with whitespace while generating) is still cut off.
export async function fetchJson(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    if (!resp.ok) return { ok: false, status: resp.status, data: null };
    return { ok: true, status: resp.status, data: await resp.json() };
  } catch (err) {
    throw classifyFetchError(err) ?? err;
  } finally {
    clearTimeout(timer);
  }
}

// A lookup's value plus whether it may be cached. Only definitive answers are
// cacheable: 200s and genuine not-found (404 / MediaWiki "missingtitle"). A
// 429/5xx or a network failure must never be cached — that would pin a
// degraded result (e.g. an AI-only fallback) in the cache.
export interface SourceResult<T> {
  value: T;
  cacheable: boolean;
}

interface CacheStatus {
  cacheable: boolean;
}

function noteStatus(res: JsonResponse, status: CacheStatus): void {
  if (!res.ok && res.status !== 404) status.cacheable = false;
}

// Resolves to `fallback` if `promise` hasn't settled within `ms`.
export function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// --- Wiktionary ---

export interface DictionaryResult {
  text: string;
  url: string;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
};

// The service worker has no DOMParser, so Wiktionary's HTML definitions are
// flattened with regexes — they're short inline fragments, not documents.
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+|#39);/gi, (m, name) => HTML_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

// One line per English part of speech, "(noun) first non-empty sense".
function parseWiktionary(data: any): string[] {
  const entries: any[] = Array.isArray(data?.en) ? data.en : [];
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry?.language !== "English") continue;
    const pos = typeof entry.partOfSpeech === "string" ? entry.partOfSpeech.toLowerCase() : "";
    const senses: any[] = Array.isArray(entry.definitions) ? entry.definitions : [];
    const def = senses.map((s) => stripHtml(String(s?.definition ?? ""))).find(Boolean);
    if (!pos || !def) continue;
    const line = `(${pos}) ${def}`;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines;
}

// Wiktionary titles are case-sensitive ("Entropy" 404s, "entropy" doesn't), so
// a capitalized selection that misses is retried lowercased within the same budget.
export async function lookupWiktionary(word: string, timeoutMs = SOURCE_TIMEOUT_MS): Promise<SourceResult<DictionaryResult | null>> {
  const status: CacheStatus = { cacheable: true };
  const deadline = Date.now() + timeoutMs;
  const candidates = [word, word.toLowerCase()].filter((w, i, all) => all.indexOf(w) === i);
  for (const candidate of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("TIMEOUT");
    const res = await fetchJson(
      `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(candidate)}`,
      WIKIMEDIA_INIT,
      remaining
    );
    noteStatus(res, status);
    if (!res.ok) continue;
    const lines = parseWiktionary(res.data);
    if (lines.length > 0) {
      return {
        value: { text: lines.join("\n"), url: `https://en.wiktionary.org/wiki/${encodeURIComponent(candidate)}` },
        cacheable: status.cacheable,
      };
    }
  }
  return { value: null, cacheable: status.cacheable };
}

// --- Wikipedia ---

export interface WikiSummary {
  title: string;
  text: string;
  url: string;
}

// Filters out nulls and drops entries whose resolved title was already seen
// (redirects can map multiple disambiguation entries to the same article).
// `seedTitles` pre-seeds the seen-set, e.g. with a primary result's title.
function dedupeByTitle(results: (WikiSummary | null)[], seedTitles: string[] = []): WikiSummary[] {
  const seen = new Set<string>(seedTitles);
  const out: WikiSummary[] = [];
  for (const r of results) {
    if (!r || seen.has(r.title)) continue;
    seen.add(r.title);
    out.push(r);
  }
  return out;
}

function summaryUrl(title: string): string {
  return `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
}

// A summary response → WikiSummary, or null for disambiguation pages / stub extracts.
function toWikiSummary(data: any, requestedTitle: string): WikiSummary | null {
  if (data?.type === "disambiguation") return null;
  const extract = data?.extract?.trim();
  if (!extract || extract.length <= 10) return null;
  const url = data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(requestedTitle)}`;
  return { title: data.title || requestedTitle, text: extract, url };
}

async function fetchWikiSummary(title: string, timeoutMs: number, status: CacheStatus): Promise<WikiSummary | null> {
  const res = await fetchJson(summaryUrl(title), WIKIMEDIA_INIT, timeoutMs);
  noteStatus(res, status);
  return res.ok ? toWikiSummary(res.data, title) : null;
}

function parseWikitextLinks(wikitext: string): string[] {
  const links: string[] = [];
  for (const line of wikitext.split("\n")) {
    const trimmed = line.trimStart();
    // Only consider top-level bullets (starts with * but not **)
    if (!trimmed.startsWith("*") || trimmed.startsWith("**")) continue;
    const linkRegex = /\[\[([^|\]]+?)(?:\|[^\]]+?)?\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(trimmed)) !== null) {
      const target = match[1].trim();
      // Skip non-article links
      if (target.startsWith("wikt:") || target.startsWith("Category:") ||
          target.startsWith("File:") || target.startsWith("Help:") ||
          target.startsWith("Wikipedia:")) continue;
      if (!links.includes(target)) links.push(target);
    }
  }
  return links;
}

// Splits wikitext into MediaWiki's numbered sections: [0] is the lead, and
// every heading line of ANY level (==, ===, …) starts the next section — the
// same numbering the parse API's `section=N` parameter uses.
export function splitSections(wikitext: string): string[] {
  return wikitext.split(/^(?==+[^=\n].*?=+[ \t]*$)/m);
}

// The disambiguation candidates: section 0's "most commonly refers to" links;
// if it has none, the links of sections 1–3 in order.
export function disambiguationLinks(wikitext: string): string[] {
  const sections = splitSections(wikitext);
  let links = parseWikitextLinks(sections[0] ?? "");
  if (links.length === 0) {
    links = Array.from(new Set(sections.slice(1, 4).flatMap(parseWikitextLinks)));
  }
  return links.slice(0, WIKI_DISAMBIG_MAX);
}

interface ParsedPage {
  title: string; // resolved title (after redirects)
  wikitext: string;
}

function sameTitle(a: string, b: string): boolean {
  const norm = (t: string) => t.replace(/_/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

// Whole-page wikitext, following redirects. Null when the page doesn't exist —
// MediaWiki answers that with HTTP 200 and an `error` body ("missingtitle").
async function fetchPageWikitext(title: string, timeoutMs: number, status: CacheStatus): Promise<ParsedPage | null> {
  const res = await fetchJson(
    `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&redirects=1&format=json&origin=*`,
    WIKIMEDIA_INIT,
    timeoutMs
  );
  noteStatus(res, status);
  if (!res.ok || res.data?.error || !res.data?.parse) return null;
  return { title: res.data.parse.title || title, wikitext: res.data.parse.wikitext?.["*"] || "" };
}

// Summaries for a disambiguation page's candidates, fetched in parallel. Each
// gets CANDIDATE_TIMEOUT_MS on its own: one slow article is dropped rather
// than holding up the rest (that cut doesn't affect cacheability).
async function summarizeCandidates(page: ParsedPage, seedTitles: string[], status: CacheStatus): Promise<WikiSummary[]> {
  const results = await Promise.all(disambiguationLinks(page.wikitext).map((t) =>
    fetchWikiSummary(t, CANDIDATE_TIMEOUT_MS, status).catch((err) => {
      if ((err as Error)?.message !== "TIMEOUT") status.cacheable = false;
      return null;
    })
  ));
  return dedupeByTitle(results, seedTitles);
}

// Primary summary, plus (when `expand`) extra meanings from the term's own
// disambiguation page or its "_(disambiguation)" sibling. Throws only if the
// primary summary request itself times out / hits a network error.
//
// Two serial rounds at most: the summary and the sibling disambiguation page
// are fetched together (with redirects followed, "X (disambiguation)" often
// resolves to X itself — covering a primary that is a disambiguation page),
// then the candidate summaries. Only if X is a disambiguation page that the
// sibling didn't resolve to is X's own wikitext fetched (one extra round).
export async function lookupWikipedia(
  text: string,
  { expand = true, timeoutMs = SOURCE_TIMEOUT_MS }: { expand?: boolean; timeoutMs?: number } = {}
): Promise<SourceResult<WikiSummary[]>> {
  const status: CacheStatus = { cacheable: true };
  const siblingPage: Promise<ParsedPage | null> = expand
    ? fetchPageWikitext(`${text}_(disambiguation)`, DISAMBIG_BUDGET_MS, status).catch(() => {
        status.cacheable = false;
        return null;
      })
    : Promise.resolve(null);

  const summary = await fetchJson(summaryUrl(text), WIKIMEDIA_INIT, timeoutMs);
  noteStatus(summary, status);
  if (!summary.ok) return { value: [], cacheable: status.cacheable };

  const isDisambiguation = summary.data?.type === "disambiguation";
  const primary = isDisambiguation ? null : toWikiSummary(summary.data, text);
  if (!expand) return { value: primary ? [primary] : [], cacheable: status.cacheable };
  if (!isDisambiguation && !primary) return { value: [], cacheable: status.cacheable };

  const expansion = async (): Promise<WikiSummary[]> => {
    let page = await siblingPage;
    if (isDisambiguation) {
      // The sibling must have resolved to X itself; otherwise fetch X's page.
      const primaryTitle = summary.data?.title || text;
      if (!page || !sameTitle(page.title, primaryTitle)) page = await fetchPageWikitext(text, DISAMBIG_BUDGET_MS, status);
      return page ? summarizeCandidates(page, [], status) : [];
    }
    // A sibling that redirects back to the article itself is not a disambiguation page.
    if (!page || sameTitle(page.title, primary!.title)) return [primary!];
    const additional = await summarizeCandidates(page, [primary!.title], status);
    return [primary!, ...additional].slice(0, WIKI_DISAMBIG_MAX);
  };

  const fallback = primary ? [primary] : [];
  let completed = false;
  const value = await withDeadline(
    expansion().then((v) => { completed = true; return v; }).catch(() => fallback),
    DISAMBIG_BUDGET_MS,
    fallback
  );
  return { value, cacheable: status.cacheable && completed };
}
