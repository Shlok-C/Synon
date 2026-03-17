import type { Definition, PopupState } from "../shared/types";
import type { PopupElements } from "./popup-ui";

export interface PopupStateManager {
  readonly currentState: PopupState | null;
  readonly stackLength: number;
  setLoadingState(word: string): void;
  setDefinitions(definitions: Definition[], error?: string): void;
  pushAndLoad(word: string): void;
  popStack(): void;
  navigatePrev(): void;
  navigateNext(): void;
  reset(): void;
}

export function createPopupStateManager(elements: PopupElements): PopupStateManager {
  let popupStack: PopupState[] = [];
  let currentPopupState: PopupState | null = null;

  function renderCurrentState(): void {
    if (!currentPopupState) return;

    const { word, definitions, index } = currentPopupState;
    const def = definitions[index] as Definition | undefined;
    elements.wordEl.textContent = def?.title || word;

    elements.bodyEl.classList.remove("synon-loading", "synon-error");

    if (definitions.length === 0) {
      elements.bodyEl.textContent = "Defining\u2026";
      elements.bodyEl.classList.add("synon-loading");
      elements.sourceEl.classList.add("synon-hidden");
    } else {
      elements.bodyEl.textContent = def!.text;

      if (def!.rootWord) {
        const rootSpan = document.createElement("span");
        rootSpan.className = "synon-root";
        rootSpan.textContent = `(root: ${def!.rootWord})`;
        elements.bodyEl.appendChild(rootSpan);
      }

      if (elements.sourceEl && elements.sourceLinkEl) {
        if (def!.url) {
          elements.sourceLinkEl.href = def!.url;
          elements.sourceLinkEl.textContent = def!.source;
          elements.sourceEl.textContent = "";
          elements.sourceEl.appendChild(document.createTextNode("Source: "));
          elements.sourceEl.appendChild(elements.sourceLinkEl);
        } else {
          elements.sourceEl.textContent = `Source: ${def!.source}`;
        }
        elements.sourceEl.classList.remove("synon-hidden");
      }
    }

    // Back button visibility
    if (popupStack.length > 0) {
      elements.backBtn.classList.remove("synon-hidden");
    } else {
      elements.backBtn.classList.add("synon-hidden");
    }

    // Footer visibility
    if (definitions.length > 1) {
      elements.navEl.classList.remove("synon-hidden");
      elements.navLabel.textContent = `${index + 1} / ${definitions.length}`;
    } else {
      elements.navEl.classList.add("synon-hidden");
    }
  }

  return {
    get currentState() {
      return currentPopupState;
    },

    get stackLength() {
      return popupStack.length;
    },

    setLoadingState(word: string): void {
      currentPopupState = { word, definitions: [], index: 0 };
      renderCurrentState();
    },

    setDefinitions(definitions: Definition[], error?: string): void {
      if (!currentPopupState) return;

      if (error && definitions.length === 0) {
        currentPopupState.definitions = [];
        elements.bodyEl.classList.remove("synon-loading");
        elements.bodyEl.classList.add("synon-error");
        elements.bodyEl.textContent = error;
        elements.navEl.classList.add("synon-hidden");
        elements.sourceEl.classList.add("synon-hidden");
        return;
      }

      if (definitions.length === 0) {
        elements.bodyEl.classList.remove("synon-loading");
        elements.bodyEl.classList.add("synon-error");
        elements.bodyEl.textContent = "Something went wrong.";
        elements.navEl.classList.add("synon-hidden");
        elements.sourceEl.classList.add("synon-hidden");
        return;
      }

      currentPopupState.definitions = definitions;
      currentPopupState.index = 0;
      renderCurrentState();
    },

    pushAndLoad(word: string): void {
      if (currentPopupState && currentPopupState.definitions.length > 0) {
        popupStack.push({ ...currentPopupState });
      }
      currentPopupState = { word, definitions: [], index: 0 };
      renderCurrentState();
    },

    popStack(): void {
      if (popupStack.length === 0) return;
      currentPopupState = popupStack.pop()!;
      renderCurrentState();
    },

    navigatePrev(): void {
      if (!currentPopupState || currentPopupState.definitions.length <= 1) return;
      currentPopupState.index =
        (currentPopupState.index - 1 + currentPopupState.definitions.length) %
        currentPopupState.definitions.length;
      renderCurrentState();
    },

    navigateNext(): void {
      if (!currentPopupState || currentPopupState.definitions.length <= 1) return;
      currentPopupState.index =
        (currentPopupState.index + 1) % currentPopupState.definitions.length;
      renderCurrentState();
    },

    reset(): void {
      popupStack = [];
      currentPopupState = null;
    },
  };
}
