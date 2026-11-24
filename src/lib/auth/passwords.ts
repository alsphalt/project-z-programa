import bcrypt from 'bcryptjs';

// The policy lives in a pure module so the login form can enforce the exact same
// rules client-side. Re-exported here to keep existing server-side imports working.
export { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, passwordProblems } from './password-policy';

const ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}
