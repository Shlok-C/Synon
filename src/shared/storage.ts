// Promise wrapper around chrome.storage.*.get's callback API. Returns the
// raw result object — callers apply their own field defaults/coercion on top.
export function storageGet<T = Record<string, unknown>>(
  area: "sync" | "local",
  keys: string | string[] | Record<string, unknown> | null
): Promise<T> {
  return new Promise((resolve) => {
    chrome.storage[area].get(keys, (result) => resolve(result as T));
  });
}
