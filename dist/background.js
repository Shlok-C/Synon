"use strict";
(() => {
  // src/background.ts
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "DEFINE") return false;
    const { selectedText, pageContext } = message;
    handleDefine(selectedText, pageContext).then(sendResponse);
    return true;
  });
  async function handleDefine(selectedText, pageContext) {
    const apiKey = await getApiKey();
    if (!apiKey) {
      return { definition: "No API key set. Open the extension popup to configure." };
    }
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 256,
          messages: [
            {
              role: "user",
              content: `Define "${selectedText}" in the context of this page:

${pageContext}`
            }
          ]
        })
      });
      const data = await response.json();
      const text = data?.content?.[0]?.text ?? "Could not generate a definition.";
      return { definition: text };
    } catch (err) {
      console.error("Synon API error:", err);
      return { definition: "Error calling API." };
    }
  }
  async function getApiKey() {
    return new Promise((resolve) => {
      chrome.storage.sync.get("apiKey", (result) => {
        resolve(result.apiKey ?? null);
      });
    });
  }
})();
