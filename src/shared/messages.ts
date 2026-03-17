import type { Definition } from "./types";

export const MSG_DEFINE = "DEFINE" as const;
export const MSG_SHOW_DEFINITION = "SHOW_DEFINITION" as const;
export const MSG_PDF_DETECTED = "PDF_DETECTED" as const;

export interface DefineMessage {
  type: typeof MSG_DEFINE;
  selectedText: string;
  pageContext: string;
  exactMode: boolean;
  verbosity: number;
}

export interface ShowDefinitionMessage {
  type: typeof MSG_SHOW_DEFINITION;
  selectedText: string;
  definitions: Definition[];
  error?: string;
}

export interface PDFDetectedMessage {
  type: typeof MSG_PDF_DETECTED;
  url: string;
}

