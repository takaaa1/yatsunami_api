/**
 * Mesma política que o app: input hostil por defeito até validação e persistência.
 * Usar com @Sanitized() nos DTOs (class-transformer + ValidationPipe).
 */

export type UserInputSanitizeKind =
  | 'plain'
  | 'multiline'
  | 'email'
  | 'minimal'
  | 'numeric';

const BIDI_AND_ISOLATES = /[\u202A-\u202E\u2066-\u2069]/g;

const DEFAULT_MAX: Record<UserInputSanitizeKind, number> = {
  plain: 8192,
  multiline: 32768,
  email: 254,
  minimal: 2048,
  numeric: 64,
};

function stripNullBytes(s: string): string {
  return s.replace(/\u0000/g, '');
}

function stripBidiAndBom(s: string): string {
  return s.replace(BIDI_AND_ISOLATES, '').replace(/\uFEFF/g, '');
}

function stripControlsMultiline(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function stripControlsPlain(s: string): string {
  let out = s.replace(/[\u0000-\u001F\u007F]/g, '');
  out = out.replace(/[\u0080-\u009F]/g, '');
  out = out.replace(/[\u2028\u2029]/g, ' ');
  return out;
}

export interface SanitizeUserInputOptions {
  kind?: UserInputSanitizeKind;
  maxLength?: number;
}

export function sanitizeUserInput(raw: unknown, options: SanitizeUserInputOptions = {}): string {
  if (raw === null || raw === undefined) {
    return '';
  }
  if (typeof raw !== 'string') {
    return '';
  }

  const kind = options.kind ?? 'plain';
  let s = stripNullBytes(raw);

  if (kind === 'minimal') {
    const max = options.maxLength ?? DEFAULT_MAX.minimal;
    return s.length > max ? s.slice(0, max) : s;
  }

  try {
    s = s.normalize('NFC');
  } catch {
    /* ignore */
  }

  const defaultCap = DEFAULT_MAX[kind];
  const cap =
    options.maxLength !== undefined ? Math.min(options.maxLength, defaultCap) : defaultCap;

  if (kind === 'email') {
    s = stripBidiAndBom(s.trim().toLowerCase());
    s = s.replace(/[\u0000-\u001F\u007F]/g, '');
    return s.length > cap ? s.slice(0, cap) : s;
  }

  if (kind === 'numeric') {
    s = stripBidiAndBom(s);
    s = s.replace(/[^\d.,\-]/g, '');
    return s.length > cap ? s.slice(0, cap) : s;
  }

  s = stripBidiAndBom(s);

  if (kind === 'multiline') {
    s = stripControlsMultiline(s);
  } else {
    s = stripControlsPlain(s);
    s = s.trim();
  }

  return s.length > cap ? s.slice(0, cap) : s;
}
