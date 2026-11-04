const SESSION_KEY = 'rs3.playerSession';

export type PlayerSession = {
  token: string;
  expiresAt: string;
};

export function readPlayerSession(): PlayerSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlayerSession>;
    if (
      typeof parsed.token === 'string' &&
      parsed.token.trim() &&
      typeof parsed.expiresAt === 'string' &&
      parsed.expiresAt.trim()
    ) {
      return { token: parsed.token.trim(), expiresAt: parsed.expiresAt.trim() };
    }
  } catch {}
  return null;
}

export function writePlayerSession(session: PlayerSession) {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      token: session.token.trim(),
      expiresAt: session.expiresAt.trim(),
    }),
  );
}

export function clearPlayerSession() {
  localStorage.removeItem(SESSION_KEY);
}
