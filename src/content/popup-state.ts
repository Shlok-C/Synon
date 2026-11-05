import type { Definition, PopupState, PopupSchema } from "../shared/types";
import type { PopupElements } from "./popup-ui";

export interface PopupStateManager {
  readonly currentState: PopupState | null;
  readonly stackLength: number;
  setLoadingState(word: string): void;
  setDefinitions(definitions: Definition[], error?: string): void;
  updateDefinitions(definitions: Definition[], target?: PopupState): void;
  setSchema(schema: PopupSchema, target?: PopupState): void;
  hasState(state: PopupState): boolean;
  pin(): void;
  pushAndLoad(word: string): void;
  popStack(): void;
  navigatePrev(): void;
  navigateNext(): void;
  reset(): void;
}

function sameDefinition(a: Definition, b: Definition): boolean {
  return a.source === b.source && a.url === b.url && a.text === b.text;
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

    renderControls();
  }

  // Back button + "i / N" footer only — never touches the body text.
  function renderControls(): void {
    if (!currentPopupState) return;
    const { definitions, index } = currentPopupState;

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

    // Progressive display: replaces a state's definitions with a newer (larger
    // or reordered) list. `target` defaults to the showing state; a stacked
    // level (the user drilled into a nested word meanwhile) is updated too and
    // rendered when popped back to. Until the state is pinned (←/→ or a press
    // inside the popup), the first — best — meaning is shown; once pinned, the
    // definition being read stays. If the shown definition is unchanged, only
    // the controls re-render, so a selection in the body text survives.
    updateDefinitions(definitions: Definition[], target?: PopupState): void {
      const state = target ?? currentPopupState;
      if (!state || definitions.length === 0) return;
      const prevShown = state.definitions[state.index] as Definition | undefined;
      const keep = state.pinned && prevShown ? definitions.findIndex((d) => sameDefinition(d, prevShown)) : -1;
      state.definitions = definitions;
      state.index = keep >= 0 ? keep : 0;
      if (state !== currentPopupState) return;
      if (prevShown && sameDefinition(prevShown, definitions[state.index])) renderControls();
      else renderCurrentState();
    },

    setSchema(schema: PopupSchema, target?: PopupState): void {
      const state = target ?? currentPopupState;
      if (state) state.schema = schema;
    },

    // True while `state` is showing or waiting on the back stack.
    hasState(state: PopupState): boolean {
      return state === currentPopupState || popupStack.includes(state);
    },

    // The user is interacting with what's on screen — later updates must not
    // move it (see updateDefinitions).
    pin(): void {
      if (currentPopupState) currentPopupState.pinned = true;
    },

    pushAndLoad(word: string): void {
      if (currentPopupState && currentPopupState.definitions.length > 0) {
        // The state object itself, not a copy: in-flight results for this
        // level must still find it (by identity) after the user drills in.
        popupStack.push(currentPopupState);
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
      currentPopupState.pinned = true;
      renderCurrentState();
    },

    navigateNext(): void {
      if (!currentPopupState || currentPopupState.definitions.length <= 1) return;
      currentPopupState.index =
        (currentPopupState.index + 1) % currentPopupState.definitions.length;
      currentPopupState.pinned = true;
      renderCurrentState();
    },

    reset(): void {
      popupStack = [];
      currentPopupState = null;
    },
  };
}
