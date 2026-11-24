/** Presentation helpers shared by the deployment routes and pages. */

export function publicId(id: string): string {
  return `DN-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export function toUiStatus(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'SUCCEEDED';
    case 'failed':
      return 'FAILED';
    case 'rolled_back':
    case 'rolled-back':
      return 'ROLLED_BACK';
    case 'running':
      return 'RUNNING';
    default:
      return 'PENDING';
  }
}

/** `health` is stored as jsonb; only an explicit verdict counts as healthy. */
export function healthOk(value: unknown): boolean | null {
  if (!value || typeof value !== 'object') return null;
  const verdict = (value as { verdict?: unknown }).verdict;
  if (verdict === 'healthy') return true;
  if (verdict === 'unhealthy') return false;
  return null;
}
