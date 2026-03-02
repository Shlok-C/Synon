import type { SelectionType } from "./types";

export function isGibberish(word: string): boolean {
  const lower = word.toLowerCase();
  if (lower.length < 2) return true;
  if (!/[aeiouy]/.test(lower)) return true;
  if (/[^aeiouy]{5,}/.test(lower)) return true;
  if (/(.)\1{2,}/.test(lower)) return true;
  if (lower.length >= 4) {
    const vowelCount = (lower.match(/[aeiouy]/g) || []).length;
    if (vowelCount / lower.length < 0.15) return true;
  }
  return false;
}

export function classify(text: string): SelectionType {
  const trimmed = text.trim();
  if (!trimmed) return "invalid";

  if (!/[a-zA-Z]/.test(trimmed)) return "invalid";

  const words = trimmed.split(/\s+/);

  if (words.length === 1) {
    if (!/^[a-zA-Z][a-zA-Z'\-]*$/.test(trimmed)) return "invalid";
    if (isGibberish(trimmed)) return "invalid";
    return "word";
  }

  if (words.length > 5) return "invalid";

  const allValid = words.every((w) => /[a-zA-Z]/.test(w));
  return allValid ? "phrase" : "invalid";
}
