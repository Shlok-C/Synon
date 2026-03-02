type SelectionType = "word" | "phrase" | "invalid";

function classify(text: string): SelectionType {
  const trimmed = text.trim();
  if (!trimmed) return "invalid";

  // Must contain at least one letter
  if (!/[a-zA-Z]/.test(trimmed)) return "invalid";

  // Split on whitespace to count words
  const words = trimmed.split(/\s+/);

  // Single token: valid word if it's mostly alphabetic (allow hyphens, apostrophes)
  if (words.length === 1) {
    return /^[a-zA-Z][a-zA-Z'\-]*$/.test(trimmed) ? "word" : "invalid";
  }

  // Multiple tokens: phrase if each token has at least one letter
  const allValid = words.every((w) => /[a-zA-Z]/.test(w));
  return allValid ? "phrase" : "invalid";
}

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

    // Skip disambiguation pages
    if (data.type === "disambiguation") return null;

    const extract = data.extract?.trim();
    if (!extract || extract.length <= 10) return null;

    const url = data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(text)}`;
    return { text: extract, url };
  } catch {
    return null;
  }
}

// Register context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "synon-define",
    title: 'Define "%s"',
    contexts: ["selection"],
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "synon-define" || !info.selectionText) return;

  const selectedText = info.selectionText.trim();
  if (!selectedText) return;

  const result = await handleDefine(selectedText, "");

  // Try sending to content script (works on normal pages)
  if (tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "SHOW_DEFINITION",
        selectedText,
        definitions: result.definitions,
        error: result.error,
      });
      return; // Content script handled it
    } catch {
      // Content script not available (PDF, chrome:// pages, etc.)
    }
  }

  // Fallback: store in local storage and show badge
  const fallbackDef = result.definitions[0]?.text ?? null;
  await chrome.storage.local.set({
    synonPendingDefinition: {
      word: selectedText,
      definition: fallbackDef,
      error: result.error,
    },
  });
  chrome.action.setBadgeText({ text: "1" });
  chrome.action.setBadgeBackgroundColor({ color: "#4A90D9" });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "DEFINE") {
    const { selectedText, pageContext } = message as {
      selectedText: string;
      pageContext: string;
    };
    handleDefine(selectedText, pageContext).then(sendResponse);
    return true;
  }

  if (message.type === "BADGE_CLEAR") {
    chrome.action.setBadgeText({ text: "" });
    return false;
  }

  return false;
});

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

interface Definition {
  source: string;
  text: string;
  url: string | null;
}

async function handleDefine(
  selectedText: string,
  pageContext: string
): Promise<{ definitions: Definition[]; error?: string }> {
  const type = classify(selectedText);
  if (type === "invalid") {
    return { definitions: [], error: "Please select a valid word or phrase." };
  }

  // Run dictionary and wikipedia lookups in parallel
  const [dictResult, wikiResult] = await Promise.all([
    lookupDictionary(selectedText),
    lookupWikipedia(selectedText),
  ]);

  const definitions: Definition[] = [];
  if (dictResult) definitions.push({ source: "Dictionary", text: dictResult.text, url: dictResult.url });
  if (wikiResult) definitions.push({ source: "Wikipedia", text: wikiResult.text, url: wikiResult.url });

  // Fall back to AI only if both free sources failed
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

  return { definitions };
}

async function getApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.sync.get("apiKey", (result) => {
      resolve(result.apiKey ?? null);
    });
  });
}
