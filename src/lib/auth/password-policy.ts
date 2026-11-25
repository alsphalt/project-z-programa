/**
 * Single source of truth for the password policy.
 *
 * Deliberately pure (no bcrypt / no node APIs) so the browser can import it and
 * show the exact same rules the API enforces. Previously the UI hint said only
 * "Minimum 12 characters" while the server also demanded upper/lower/number/symbol,
 * so users only discovered the real policy from a 422 after submitting.
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

export type PasswordRule = {
  /** Short label shown as a checklist item in the UI. */
  hint: string;
  /** Full sentence used in API error messages. */
  message: string;
  test: (value: string) => boolean;
};

export const PASSWORD_RULES: PasswordRule[] = [
  {
    hint: 'At least 12 characters',
    message: 'Must be at least 12 characters long',
    test: (value) => value.length >= PASSWORD_MIN_LENGTH,
  },
  {
    hint: 'One uppercase letter (A-Z)',
    message: 'Must include an uppercase letter',
    test: (value) => /[A-Z]/.test(value),
  },
  {
    hint: 'One lowercase letter (a-z)',
    message: 'Must include a lowercase letter',
    test: (value) => /[a-z]/.test(value),
  },
  {
    hint: 'One number (0-9)',
    message: 'Must include a number',
    test: (value) => /[0-9]/.test(value),
  },
  {
    hint: 'One symbol (! @ # $ % & * ? - _)',
    message: 'Must include a symbol',
    test: (value) => /[^A-Za-z0-9]/.test(value),
  },
];

/** Returns the list of unmet policy rules, as user-facing sentences. Empty array = valid. */
export function passwordProblems(password: string): string[] {
  const problems = PASSWORD_RULES.filter((rule) => !rule.test(password)).map((rule) => rule.message);
  if (password.length > PASSWORD_MAX_LENGTH) problems.push('Must be at most 200 characters long');
  return problems;
}

/** Per-rule pass/fail, used to render the live checklist. */
export function passwordChecklist(password: string): Array<{ hint: string; met: boolean }> {
  return PASSWORD_RULES.map((rule) => ({ hint: rule.hint, met: rule.test(password) }));
}

export function isPasswordValid(password: string): boolean {
  return passwordProblems(password).length === 0;
}
