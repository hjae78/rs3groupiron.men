export const SITE_NAME = 'RS3 Group Ironman';

/**
 * Canonical origin, no trailing slash. Every canonical link, og:url and
 * absolute share image is built from this, so moving domain is a one-line
 * change here plus the three files that cannot read it: index.html,
 * public/robots.txt and public/sitemap.xml.
 */
export const SITE_URL = 'https://rs3groupiron.men';

/**
 * Per-route search copy. Titles get " · RS3 Group Ironman" appended; the
 * landing page keeps the longer title set in index.html.
 */
export const PAGE_SEO = {
  login: {
    title: 'Login',
    description:
      "Enter your group name and token to open your group's dashboard.",
  },
  getStarted: {
    title: 'Create your group',
    description:
      'Set up a Group Ironman group in a minute and connect each member’s tracker.',
  },
  browse: {
    title: 'Discover groups',
    description:
      'Search RS3 Group Ironman groups by name, or browse the most viewed and highest total level groups.',
  },
} as const;

/** Days between an erasure request and the purge; mirrors the API constant. */
export const DELETION_GRACE_DAYS = 5;

export const PLAYER_DELETION_GRACE_HOURS = 24;

/** Max length for RuneScape usernames. */
export const MAX_NAME = 12;
export const MAX_GROUP_NAME = 20;
export const MIN_SLOTS = 2;
export const MAX_SLOTS = 5;

/** How long "Copied" feedback stays visible. */
export const COPY_FEEDBACK_MS = 1600;

// TODO: replace placeholder video
export const SETUP_VIDEO_URL =
  'https://www.youtube-nocookie.com/embed/Qtv9AhfjA1Y';

export const TOKEN_HINT =
  'Use this token in the plugin Authorization header to sync your group.';

export const DISCORD_URL = 'https://discord.gg/gHN7c9B5FU';
export const COFFEE_URL = 'https://buymeacoffee.com/openrune';
