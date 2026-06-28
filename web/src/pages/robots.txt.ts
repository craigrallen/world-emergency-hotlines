import type { APIRoute } from 'astro';

import { SITE_URL } from '../lib/site';

export const GET: APIRoute = () => {
  const sitemapUrl = new URL('/sitemap.xml', SITE_URL).toString();
  const body = ['User-agent: *', 'Allow: /', `Sitemap: ${sitemapUrl}`, ''].join('\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
};