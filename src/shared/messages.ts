import type { Definition, OutlineCandidate, OutlineNode, PageKind } from "./types";

export const MSG_DEFINE = "DEFINE" as const;
export const MSG_SHOW_DEFINITION = "SHOW_DEFINITION" as const;
export const MSG_PDF_DETECTED = "PDF_DETECTED" as const;
export const MSG_PDF_VIEWER_OPENED = "PDF_VIEWER_OPENED" as const;
export const MSG_GET_ARTICLE_SNAPSHOT = "GET_ARTICLE_SNAPSHOT" as const;
export const MSG_GENERATE_PDF_OUTLINE = "GENERATE_PDF_OUTLINE" as const;

export interface DefineMessage {
  type: typeof MSG_DEFINE;
  selectedText: string;
  pageContext: string;
  exactMode: boolean;
  verbosity: number;
  pageKind: PageKind;
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

export interface PDFViewerOpenedMessage {
  type: typeof MSG_PDF_VIEWER_OPENED;
  url: string;
}

export interface GetArticleSnapshotMessage {
  type: typeof MSG_GET_ARTICLE_SNAPSHOT;
}

export interface ArticleSnapshotResponse {
  title: string;
  faviconUrl: string | null;
  text: string;
}

export interface GeneratePdfOutlineMessage {
  type: typeof MSG_GENERATE_PDF_OUTLINE;
  candidates: OutlineCandidate[];
}

export interface GeneratePdfOutlineResponse {
  // null = the call itself failed (no key, timeout, network, bad reply) — not cacheable.
  // [] = the model succeeded but found no real headings — cacheable.
  nodes: OutlineNode[] | null;
}

