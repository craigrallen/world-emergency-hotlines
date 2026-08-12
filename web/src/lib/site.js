const DEFAULT_SITE_URL = 'https://world-emergency-hotlines-production.up.railway.app';

function normalizeSiteUrl(value) {
  const candidate = String(value || DEFAULT_SITE_URL).trim();
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return DEFAULT_SITE_URL;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return DEFAULT_SITE_URL;
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export const SITE_URL = normalizeSiteUrl(process.env.PUBLIC_SITE_URL);
export { DEFAULT_SITE_URL, normalizeSiteUrl };
