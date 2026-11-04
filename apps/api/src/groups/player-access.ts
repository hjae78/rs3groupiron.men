import { createHash, randomUUID } from 'node:crypto';

export const ACCESS_TOKEN_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export function hashAccessToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateAccessToken(): { token: string; tokenHash: string } {
  const token = randomUUID();
  return { token, tokenHash: hashAccessToken(token) };
}

export function accessTokenExpiresAt(from: Date): Date {
  return new Date(from.getTime() + ACCESS_TOKEN_TTL_MS);
}

export function isAccessCredentialUsable(
  row: { expiresAt: Date; revokedAt: Date | null },
  now: Date,
): boolean {
  if (row.revokedAt != null) return false;
  return row.expiresAt.getTime() > now.getTime();
}
