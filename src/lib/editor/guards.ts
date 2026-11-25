/**
 * Pure rules shared by the code editor UI and its tests.
 *
 * The editor used to be able to hand an empty buffer to a save/deploy call: the
 * panel response had a body, the tab showed a size, but the surface was blank and
 * whatever was in the editor (nothing) was what got written. These guards make
 * that state impossible to reach by accident — an empty buffer over a non-empty
 * production file is refused before any request is made.
 */

export interface WriteGuardInput {
  /** Bytes the panel reported for the production file that was opened. */
  productionBytes: number | null | undefined;
  /** Current editor buffer. */
  content: string;
  /**
   * Set only when the user deliberately asked to write an empty file (the UI has
   * no such control today, so this always defaults to false).
   */
  allowEmpty?: boolean;
}

export type WriteGuardVerdict = { ok: true } | { ok: false; reason: string };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Refuse to persist an empty buffer over a file that has bytes on disk.
 *
 * This is the difference between "the editor is broken" and "the editor silently
 * emptied production". The second one is unrecoverable for the user, so it is
 * blocked here rather than being left to a confirmation dialog.
 */
export function checkWrite(input: WriteGuardInput): WriteGuardVerdict {
  const productionBytes = Number(input.productionBytes ?? 0);
  if (input.allowEmpty) return { ok: true };
  if (productionBytes > 0 && input.content.length === 0) {
    return {
      ok: false,
      reason:
        `The editor buffer is empty but this file holds ${formatBytes(productionBytes)} on production. ` +
        'Refusing to save — reload the file first so the real source is in the editor again.',
    };
  }
  if (productionBytes > 0 && input.content.trim().length === 0) {
    return {
      ok: false,
      reason:
        'The editor buffer only contains whitespace. Refusing to overwrite a non-empty production file ' +
        'with it — reload the file, then edit.',
    };
  }
  return { ok: true };
}

/**
 * A load is only usable when the received text is exactly what the panel said it
 * would send. Returning a short string used to look like "the editor is empty"
 * instead of "the read was truncated".
 */
export function checkLoadedContent(input: {
  path: string;
  content: string;
  totalChars: number;
  sizeBytes: number | null | undefined;
}): { ok: true } | { ok: false; reason: string } {
  if (input.totalChars > 0 && input.content.length !== input.totalChars) {
    return {
      ok: false,
      reason:
        `${input.path}: received ${input.content.length.toLocaleString()} of ` +
        `${input.totalChars.toLocaleString()} characters. The file was not opened so no truncated copy could be edited or saved.`,
    };
  }
  const sizeBytes = Number(input.sizeBytes ?? 0);
  if (sizeBytes > 0 && input.content.length === 0) {
    return {
      ok: false,
      reason:
        `${input.path}: production reports ${formatBytes(sizeBytes)} but the panel returned an empty body. ` +
        'Nothing was opened — check the Client API key permissions (file.read) and try again.',
    };
  }
  return { ok: true };
}

/** Languages where an empty buffer is almost always a broken load, not an edit. */
export function isCodeLanguage(language: string): boolean {
  return !['plaintext', 'markdown', 'text'].includes(language);
}
