import type { APIRoute } from 'astro';

import { SITE_URL } from '../lib/site';

export const GET: APIRoute = () => {
  const sitemapUrl = new URL('/sitemap.xml', SITE_URL).toString();
  const disallowed = ['/api/', '/gateway/', '/release/v1/', '/subscriptions/', '/organizations/', '/managed-widget-config/', '/technical-health/', '/assurance-packs/', '/provider-claims/', '/reviewer-work-queue/', '/managed-api-plans/', '/feeds/'];
  const body = ['User-agent: *', 'Allow: /', ...disallowed.map((path) => `Disallow: ${path}`), '', `Sitemap: ${sitemapUrl}`, ''].join('\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
};
