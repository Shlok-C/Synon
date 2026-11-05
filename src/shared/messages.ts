import type { Definition, DefineResponse, OutlineCandidate, OutlineNode, PageKind } from "./types";

export const MSG_DEFINE = "DEFINE" as const;
export const MSG_SHOW_DEFINITION = "SHOW_DEFINITION" as const;
export const MSG_PDF_DETECTED = "PDF_DETECTED" as const;
export const MSG_PDF_VIEWER_OPENED = "PDF_VIEWER_OPENED" as const;
export const MSG_PDF_BYPASS = "PDF_BYPASS" as const;
export const MSG_GET_ARTICLE_SNAPSHOT = "GET_ARTICLE_SNAPSHOT" as const;
export const MSG_GENERATE_PDF_OUTLINE = "GENERATE_PDF_OUTLINE" as const;
export const MSG_SWITCH_TAB = "SWITCH_TAB" as const;
export const MSG_DEFINE_PARTIAL = "DEFINE_PARTIAL" as const;
export const MSG_DEFINE_RESULT = "DEFINE_RESULT" as const;
export const MSG_WARMUP = "WARMUP" as const;

// Define requests run over a long-lived port (not sendMessage) so the background
// can stream interim results: content posts a DefineMessage, background posts
// zero or more DefinePartialMessages, then one DefineResultMessage, then disconnects.
export const DEFINE_PORT_NAME = "synon-define";

export interface DefineMessage {
  type: typeof MSG_DEFINE;
  selectedText: string;
  pageContext: string;
  exactMode: boolean;
  verbosity: number;
  pageKind: PageKind;
}

export interface DefinePartialMessage {
  type: typeof MSG_DEFINE_PARTIAL;
  definitions: Definition[];
}

export interface DefineResultMessage {
  type: typeof MSG_DEFINE_RESULT;
  response: DefineResponse;
}

// Fire-and-forget: wakes the service worker while the user is still selecting,
// so its cold start overlaps the gesture instead of delaying the define request.
export interface WarmupMessage {
  type: typeof MSG_WARMUP;
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

// Sent by the viewer's "Open original" fallback just before it navigates to
// the raw PDF URL, so the background lets Chrome handle that URL natively
// (display or download) instead of redirecting it straight back to the viewer.
export interface PDFBypassMessage {
  type: typeof MSG_PDF_BYPASS;
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

export interface SwitchTabMessage {
  type: typeof MSG_SWITCH_TAB;
  direction: "prev" | "next";
}
