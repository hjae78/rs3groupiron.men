/**
 * The policy pages' metadata, kept apart from their text.
 *
 * The routes, the footer and the cross-links between policies all need the
 * slugs and titles; only the page itself needs the prose. Splitting them is
 * what keeps ~30 KB of legal copy out of the entry chunk, since the eager
 * marketing pages import this module and not `legal.ts`.
 */

export type LegalSlug = 'privacy' | 'terms' | 'cookies';

export type LegalPageMeta = {
  slug: LegalSlug;
  title: string;
  shortTitle: string;
  description: string;
};

export const LEGAL_UPDATED = '3 November 2026';

export const LEGAL_CONTACT = {
  operator: 'Alexander Thorén',
  email: 'privacy@rs3groupiron.men',
  site: 'rs3groupiron.men',
};

export const LEGAL_PAGES: LegalPageMeta[] = [
  {
    slug: 'privacy',
    title: 'Privacy notice',
    shortTitle: 'Privacy',
    description:
      'What RS3 Group Ironman does with your group data, where it is stored, how long it is kept and how to have it deleted.',
  },
  {
    slug: 'terms',
    title: 'Terms of use',
    shortTitle: 'Terms',
    description:
      'The terms you agree to when you use the RS3 Group Ironman site or plugin.',
  },
  {
    slug: 'cookies',
    title: 'Cookies and local storage',
    shortTitle: 'Cookies',
    description:
      'RS3 Group Ironman sets no cookies. Here is what it does keep in your browser, and why there is no cookie banner.',
  },
];

export function legalPageMeta(slug: LegalSlug): LegalPageMeta {
  const found = LEGAL_PAGES.find((page) => page.slug === slug);
  if (!found) throw new Error(`Unknown policy page: ${slug}`);
  return found;
}
