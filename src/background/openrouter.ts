// All OpenRouter LLM calls: the definition AI fallback, context-based
// reordering, and PDF outline generation.
import type { Definition, OutlineCandidate, OutlineNode } from "../shared/types";
import type { GeneratePdfOutlineResponse } from "../shared/messages";
import { storageGet } from "../shared/storage";
import { fetchJson } from "./sources";

const OPENROUTER_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
// Outline generation isn't on the define popup's critical path and asks for a
// much longer reply, so it gets its own, looser budget — but it must stay under
// requestLlmOutline's 20s wait in src/pdfjs/viewer.js so the viewer gets the answer.
const OUTLINE_TIMEOUT_MS = 18000;

// A build-time key (.env → __OPENROUTERS_KEY__) wins; otherwise the user's own (BYOK).
export async function getApiKey(): Promise<string | null> {
  if (__OPENROUTERS_KEY__) return __OPENROUTERS_KEY__;
  const result = await storageGet<{ apiKey?: string }>("sync", "apiKey");
  return result.apiKey ?? null;
}

// Returns the reply text, or null on a non-auth API error / malformed reply.
// Throws API_KEY_INVALID on 401/403, and TIMEOUT/NETWORK on transport failure.
async function callOpenRouter(
  apiKey: string,
  userContent: string,
  maxTokens: number,
  timeoutMs: number
): Promise<string | null> {
  const { ok, status, data } = await fetchJson("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "chrome-extension://synon",
      "X-Title": "Synon",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: maxTokens,
      reasoning: { enabled: false },
      messages: [{ role: "user", content: userContent }],
    }),
  }, timeoutMs);

  if (!ok) {
    if (status === 401 || status === 403) throw new Error("API_KEY_INVALID");
    console.error("Synon OpenRouter error: HTTP", status);
    return null;
  }
  const text = data?.choices?.[0]?.message?.content;
  return typeof text === "string" ? text.trim() || null : null;
}

// Definition fallback when dictionary + Wikipedia found nothing.
export async function lookupAI(
  selectedText: string,
  pageContext: string,
  apiKey: string,
  timeoutMs: number
): Promise<string | null> {
  const task = pageContext && pageContext.length > 50
    ? `Define "${selectedText}" in the context of this page:\n\n${pageContext}`
    : `Define "${selectedText}" concisely. Provide the most common meaning.`;
  // The popup renders plain text, so Markdown would show up as literal asterisks.
  const prompt = `${task}\n\nAnswer in plain text (no Markdown), 1–2 sentences.`;

  return callOpenRouter(apiKey, prompt, 256, timeoutMs);
}

// Asks which candidate best matches the page's context. Returns its 0-based
// index, or null if the reply was unusable.
export async function pickBestDefinition(
  selectedText: string,
  pageContext: string,
  candidates: Definition[],
  apiKey: string,
  timeoutMs: number
): Promise<number | null> {
  const trimmedContext = pageContext.trim().slice(0, 2000);
  const numbered = candidates
    .map((d, i) => `${i + 1}. ${d.text.replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n");

  const prompt =
`You are helping a reader understand "${selectedText}" as used in this context:

${trimmedContext}

Which numbered definition below best matches the meaning in that context? Reply with ONLY the number.

${numbered}`;

  const reply = await callOpenRouter(apiKey, prompt, 8, timeoutMs);
  if (!reply) return null;
  const match = reply.match(/\d+/);
  if (!match) return null;
  const n = parseInt(match[0], 10);
  if (!Number.isFinite(n) || n < 1 || n > candidates.length) return null;
  return n - 1;
}

function buildOutlinePrompt(candidates: OutlineCandidate[]): string {
  const lines = candidates
    .map((c, i) => {
      const hints = [c.isBold && "B", c.isLarge && "L", c.isNumbered && "N"].filter(Boolean).join(",");
      return `${i + 1}. [p${c.pageIndex}${hints ? ", " + hints : ""}] ${c.text}`;
    })
    .join("\n");

  return `You are analyzing text lines extracted from a PDF to find its section/chapter headings. Below is a numbered list of candidate lines with their 0-indexed page number and formatting hints (B=bold, L=large font, N=looks numbered).

${lines}

Identify which numbered lines are genuine section or chapter headings (ignore body text, captions, page numbers, and running headers). Respond with ONLY a JSON array of objects like [{"index":1,"level":0},{"index":5,"level":1}] where "index" matches the numbers above and "level" is 0 for top-level headings, 1 for subheadings, 2 for deeper nesting. If none of the lines are real headings, respond with exactly: []`;
}

// Last-resort PDF outline. nodes: null = the call failed (retryable, not
// cached by the viewer); [] = the model genuinely found no headings.
export async function generatePdfOutline(candidates: OutlineCandidate[]): Promise<GeneratePdfOutlineResponse> {
  try {
    if (candidates.length === 0) return { nodes: [] };

    const apiKey = await getApiKey();
    if (!apiKey) return { nodes: null };

    const reply = await callOpenRouter(apiKey, buildOutlinePrompt(candidates), 1500, OUTLINE_TIMEOUT_MS);
    if (!reply) return { nodes: null };

    const cleaned = reply.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const picks = JSON.parse(cleaned) as { index: number; level: number }[];
    if (!Array.isArray(picks)) return { nodes: null };

    const nodes: OutlineNode[] = [];
    for (const pick of picks) {
      const candidate = candidates[pick.index - 1];
      if (!candidate) continue;
      const level = Number.isFinite(pick.level) ? Math.max(0, Math.min(3, Math.trunc(pick.level))) : 0;
      nodes.push({ title: candidate.text, pageIndex: candidate.pageIndex, level, children: [] });
    }
    return { nodes };
  } catch {
    return { nodes: null };
  }
}
