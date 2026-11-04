/** Group data poll cadence (ms). The map tab polls faster so movement shows live. */
export const POLL_MS_MAP = 1500;
export const POLL_MS_DEFAULT = 5000;
/** Every Nth poll is a full (non-delta) fetch as a safety net for missed changes. */
export const FULL_REFRESH_EVERY_N_POLLS = 20;
export const PRESENCE_TIMEOUT_MS = 2 * 60 * 1000;
export const PRESENCE_CHECK_MS = 15_000;
