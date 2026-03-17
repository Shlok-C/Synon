export interface Definition {
  source: string;
  text: string;
  url: string | null;
  rootWord?: string;
  title?: string;
}

export interface PopupState {
  word: string;
  definitions: Definition[];
  index: number;
}

export type SelectionType = "word" | "phrase" | "invalid";

export interface DefineResponse {
  definitions: Definition[];
  error?: string;
  skip?: boolean;
}
