import type { APIRoute } from 'astro';

import { getCategoriesStats, getManifest } from '../lib/data';
import { SITE_URL } from '../lib/site';

const STATIC_PATHS = ['', '/about', '/find-help', '/widget', '/integrate', '/map', '/data', '/categories'];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function absoluteUrl(path: string): string {
  return new URL(path, SITE_URL).toString().replace(/\/$/, path === '' ? '/' : '');
}

export const GET: APIRoute = async () => {
  const [manifest, categoryStats] = await Promise.all([getManifest(), getCategoriesStats()]);

  const countryPaths = manifest.countries
    .map((country) => `/country/${country.alpha2.toLowerCase()}`)
    .sort();
  const categoryPaths = categoryStats.categories
    .map((category) => `/category/${category.slug}`)
    .sort();

  const urls = [...STATIC_PATHS, ...countryPaths, ...categoryPaths].map(absoluteUrl);

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
    },
  });
};
