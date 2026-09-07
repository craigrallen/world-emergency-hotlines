// Small closed-shape validators shared by the payments foundation. Every check
// is deliberately strict: unknown keys, prototypes, and non-finite numbers fail.

export function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function exactObject(value, keys, required = keys) {
  if (!plain(value)) return false;
  const own = Object.keys(value);
  return own.every((key) => keys.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

export function integer(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function nonEmptyString(value, max = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Exact HTTPS (or, when allowed, loopback HTTP) origin without path, query, fragment, or credentials. */
export function validOrigin(value, { allowHttp = false } = {}) {
  if (typeof value !== 'string' || value.length > 255 || value.endsWith('/')) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
  if (url.hostname.includes('*')) return false;
  if (url.protocol === 'https:') return url.origin === value;
  if (url.protocol === 'http:' && allowHttp) return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.origin === value;
  return false;
}

/** Absolute site path: leading slash, no query, fragment, dot segments, or control characters. */
export function validSitePath(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/.test(value)
    && !value.split('/').some((segment) => segment === '.' || segment === '..');
}
