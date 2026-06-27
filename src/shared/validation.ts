import type { SelectionType } from "./types";

const CONTRACTION_S = new Set([
  "it's", "he's", "she's", "that's", "what's", "who's",
  "there's", "here's", "where's", "how's", "let's",
  "one's", "somebody's", "someone's", "everybody's",
  "everyone's", "nobody's", "anything's", "everything's",
  "nothing's", "something's",
]);

function stripPossessive(word: string): string {
  if (CONTRACTION_S.has(word.toLowerCase())) return word;
  if (/'s$/i.test(word)) return word.slice(0, -2);
  return word;
}

export function normalizeSelection(text: string): string {
  if (!text) return text;

  // Strip outer punctuation/brackets/quotes from both ends
  let result = text.replace(
    /^[.,;:!?"""''()\[\]{}<>«»…—–\s]+|[.,;:!?"""''()\[\]{}<>«»…—–\s]+$/g,
    ""
  );

  if (!result) return text;

  // Strip trailing apostrophe (covers cats' and stray quotes)
  result = result.replace(/'$/, "");
  // Strip leading apostrophe only if not followed by a letter (preserves 'twas)
  result = result.replace(/^'(?!\p{L})/u, "");

  if (!result) return text;

  // For single words only: strip possessive 's
  if (!/\s/.test(result)) {
    result = stripPossessive(result);
  }

  return result || text;
}

// Valid English word-initial consonant clusters
const VALID_ONSETS = new Set([
  "bl", "br", "ch", "cl", "cr", "cz", "dh", "dr", "dw",
  "fl", "fr", "gh", "gl", "gn", "gr",
  "kn", "pf", "ph", "pl", "pn", "pr", "ps", "pt",
  "qu", "rh",
  "sc", "sch", "scr", "sh", "shr", "sk", "sl", "sm", "sn",
  "sp", "spl", "spr", "squ", "sq", "st", "str", "sw",
  "th", "thr", "thw", "tr", "ts", "tw",
  "wr", "wh",
]);

function hasValidOnset(lower: string): boolean {
  // Extract leading consonant cluster (everything before first vowel)
  const match = lower.match(/^[^aeiouy]+/);
  if (!match) return true; // starts with a vowel — fine
  const cluster = match[0];
  if (cluster.length < 2) return true; // single consonant — always valid
  return VALID_ONSETS.has(cluster);
}

export function isGibberish(word: string): boolean {
  const lower = word.toLowerCase();
  if (lower.length < 2) return true;
  // Skip English-specific heuristics for non-ASCII words (accented Latin, etc.)
  if (/[^\x00-\x7F]/.test(lower)) return false;
  if (!/[aeiouy]/.test(lower)) return true;
  if (/[^aeiouy]{5,}/.test(lower)) return true;
  if (/(.)\1{2,}/.test(lower)) return true;
  if (!hasValidOnset(lower)) return true;
  if (lower.length >= 4) {
    const vowelCount = (lower.match(/[aeiouy]/g) || []).length;
    if (vowelCount / lower.length < 0.15) return true;
  }
  return false;
}

export function classify(text: string): SelectionType {
  const trimmed = text.trim();
  if (!trimmed) return "invalid";

  if (!/\p{L}/u.test(trimmed)) return "invalid";

  const words = trimmed.split(/\s+/);

  if (words.length === 1) {
    if (!/^\p{L}[\p{L}'\-]*$/u.test(trimmed)) return "invalid";
    if (isGibberish(trimmed)) return "invalid";
    return "word";
  }

  if (words.length > 5) return "invalid";

  const allValid = words.every((w) => /^\p{L}[\p{L}'\-]*$/u.test(w) && !isGibberish(w));
  return allValid ? "phrase" : "invalid";
}
