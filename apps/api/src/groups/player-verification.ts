import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const VERIFICATION_TOKEN_TTL_MS = 10 * 60 * 1000;

export function hashVerificationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateVerificationToken(): {
  token: string;
  tokenHash: string;
} {
  const token = randomUUID();
  return { token, tokenHash: hashVerificationToken(token) };
}

export function verificationTokenExpiresAt(from: Date): Date {
  return new Date(from.getTime() + VERIFICATION_TOKEN_TTL_MS);
}

export function isVerificationTokenUsable(
  row: { expiresAt: Date; consumedAt: Date | null },
  now: Date,
): boolean {
  if (row.consumedAt != null) return false;
  return row.expiresAt.getTime() > now.getTime();
}

export function generateUnverifiedPlaceholder(): string {
  return `Unverified-${randomBytes(4).toString('hex')}`;
}

export function verificationUsernameMatches(
  expected: string,
  provided: string,
): boolean {
  return expected.trim().toLowerCase() === provided.trim().toLowerCase();
}

export function hashTrackingId(trackingId: string): string {
  return createHash('sha256').update(trackingId, 'utf8').digest('hex');
}
