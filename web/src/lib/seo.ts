import type { CategoryGlobalStat } from './types';

export const SITE_NAME = 'World Emergency & Hotlines';
export const SOCIAL_IMAGE_PATH = '/social-card.png';
export const SOCIAL_IMAGE_ALT = 'World Emergency & Hotlines — listings across countries and territories worldwide; coverage varies';

/** Shared crawl eligibility rule using generated aggregate facts only. */
export function isCategoryIndexable(category: Pick<CategoryGlobalStat, 'countries' | 'verified_count'>): boolean {
  return category.countries >= 2 || category.verified_count >= 2;
}

export function breadcrumbJsonLd(items: Array<{ name: string; path: string }>, site: URL | string) {
  const base = typeof site === 'string' ? new URL(site) : site;
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem', position: index + 1, name: item.name,
      item: new URL(item.path, base).toString(),
    })),
  };
}
