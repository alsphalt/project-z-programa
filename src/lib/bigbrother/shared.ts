/**
 * Answer shapes shared by the server engine and the browser renderer.
 * No server-only imports here on purpose.
 */

export interface DiagnosticFindingView {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'unknown';
  detail: string;
  href?: string;
}

export type AnswerBlock =
  | {
      type: 'steps';
      title?: string;
      steps: Array<{
        title: string;
        body: string;
        imageUrl?: string | null;
        link?: string | null;
        linkLabel?: string | null;
      }>;
    }
  | {
      type: 'files';
      title?: string;
      items: Array<{
        path: string;
        label?: string | null;
        line?: number | null;
        kind?: string;
        snippet?: string | null;
        openHref: string;
        explorerHref: string;
      }>;
    }
  | {
      type: 'errors';
      title?: string;
      items: Array<{
        id: string;
        title: string;
        code: string;
        severity: string;
        source: string;
        filePath: string | null;
        line: number | null;
        rootCause: string;
        recommendation: string;
        href: string;
        occurrences: number;
      }>;
    }
  | { type: 'diagnostics'; title?: string; at: string; findings: DiagnosticFindingView[] }
  | { type: 'note'; tone: 'info' | 'warn' | 'bad'; text: string }
  | { type: 'report'; title: string; markdown: string }
  | { type: 'links'; title?: string; items: Array<{ label: string; href?: string; detail?: string }> }
  | { type: 'images'; images: Array<{ url: string; caption: string }> };

export interface AnswerAction {
  label: string;
  href?: string;
  kind: 'navigate' | 'open-file' | 'explore' | 'scan' | 'repair';
}

export interface Citation {
  label: string;
  detail?: string;
  href?: string;
}

export interface AssistantAnswerView {
  text: string;
  blocks: AnswerBlock[];
  citations: Citation[];
  actions: AnswerAction[];
  images: Array<{ url: string; caption: string }>;
  suggestions: string[];
  intent: string;
  engine: string;
}
