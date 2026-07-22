export interface Definition {
  source: string;
  text: string;
  url: string | null;
  rootWord?: string;
  title?: string;
}

export type PageKind = "email" | "pdf" | "generic";

export interface PopupSchema {
  phrase: string;                       // normalized selected text
  selectionType: "word" | "phrase";
  wordCount: number;
  common: boolean;                      // word: isCommonWord(word); phrase: any word common
  inLexicon: boolean;                   // word only; false for phrases
  context: { length: number; pageKind: PageKind };
  settings: { exactMode: boolean; verbosity: number };
  result: {
    skipped: boolean;
    fromCache: boolean;
    definitionCount: number;
    sourceCounts: { dictionary: number; wikipedia: number; ai: number };
    wikipediaPages: string[];             // titles of all Wikipedia pages returned
    usedLemmaFallback: boolean;
    usedAiFallback: boolean;
    reorderedByLLM: boolean;
    chosenIndex: number;                // index surfaced first (0 unless LLM reordered)
    error: string | null;
  };
}

export interface PopupState {
  word: string;
  definitions: Definition[];
  index: number;
  schema?: PopupSchema;
}

export type SelectionType = "word" | "phrase" | "invalid";

export interface DefineResponse {
  definitions: Definition[];
  error?: string;
  skip?: boolean;
  schema?: PopupSchema;
}
