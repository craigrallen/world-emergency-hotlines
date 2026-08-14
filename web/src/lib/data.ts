// Data adapter.
//
// Phase 1 (current): reads the pre-built JSON shards in /public/data/.
// Phase 2: reads D1 via Astro.locals.runtime.env.HOTLINES_DB when available.
//
// Both paths return the same shape (from types.ts) so pages never care.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type {
  Country,
  Manifest,
  Hotline,
  HotlineCategory,
  CategoriesStats,
  FreshnessInfo,
  VerificationStatus,
} from './types';

// Astro 6 compiles server modules into a temp directory, so import.meta.url is
// not a reliable base for resolving project-relative paths. process.cwd() is
// always the project root (web/) when astro build/dev runs.
const DATA_DIR = pathToFileURL(resolve(process.cwd(), 'public/data') + '/');

async function readJson<T>(path: URL): Promise<T> {
  const fs = await import('node:fs/promises');
  const text = await fs.readFile(path, 'utf-8');
  return JSON.parse(text) as T;
}

export async function getManifest(): Promise<Manifest> {
  return readJson<Manifest>(new URL('manifest.json', DATA_DIR));
}

export async function getCountry(code: string): Promise<Country | null> {
  const alpha2 = code.toLowerCase();
  try {
    return await readJson<Country>(new URL(`countries/${alpha2}.json`, DATA_DIR));
  } catch {
    return null;
  }
}

export async function getAllCountries(): Promise<Country[]> {
  const manifest = await getManifest();
  return Promise.all(
    manifest.countries.map(async (c) => {
      const country = await getCountry(c.alpha2);
      if (!country) {
        throw new Error(`Missing country shard for ${c.alpha2}`);
      }
      return country;
    })
  );
}

/**
 * Returns all countries that have hotlines for the given category,
 * with each entry containing only hotlines for that category.
 * Uses the manifest's `categories` array to avoid loading unrelated shards.
 */
export async function getByCategory(
  category: string
): Promise<Array<{ country: Country; hotlines: Hotline[] }>> {
  const manifest = await getManifest();
  // Filter manifest to only countries that list this category — avoids loading all shards
  const relevant = manifest.countries.filter((c) =>
    c.categories.includes(category as HotlineCategory)
  );
  const countries = await Promise.all(relevant.map((c) => getCountry(c.alpha2)));
  return countries
    .filter((c): c is Country => c !== null)
    .map((country) => ({
      country,
      hotlines: country.hotlines.filter((h) => h.category === category),
    }))
    .filter((entry) => entry.hotlines.length > 0);
}

export async function getCategoriesStats(): Promise<CategoriesStats> {
  return readJson<CategoriesStats>(new URL('categories-stats.json', DATA_DIR));
}

// ---------- Freshness / trust helpers ----------

const SOURCE_CHECKED_SET = new Set<VerificationStatus>([
  'verified_web',
  'verified_authority',
  'verified_knowledge',
]);
const PRIORITIZED_SET = new Set<VerificationStatus>([...SOURCE_CHECKED_SET, 'cross_referenced']);

/**
 * Derives a human-readable freshness label and confidence level from a hotline.
 * Used in templates to show staleness cues without touching the canonical data.
 */
const FRESHNESS_MONTH_MS = 1000 * 60 * 60 * 24 * 30.44;

function parseVerifiedInstant(rawDate: string): Date | null {
  const calendarDate = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(rawDate);
  if (!calendarDate) return null;

  const [, rawYear, rawMonth, rawDay] = calendarDate;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;

  const time = Date.parse(rawDate);
  return Number.isFinite(time) ? new Date(time) : null;
}

export function getFreshnessInfo(hotline: Hotline, now: Date = new Date()): FreshnessInfo {
  const status = hotline.verification_status;
  const rawDate = hotline.last_verified ?? null;

  if (!SOURCE_CHECKED_SET.has(status) && status !== 'cross_referenced') {
    return { label: '', level: 'unknown', dateStr: null };
  }

  const prefix = status === 'cross_referenced' ? 'Cross-referenced' : 'Verified';
  if (!rawDate) return { label: prefix, level: 'ok', dateStr: null };

  const unavailableLabel = status === 'cross_referenced' ? 'Date unavailable' : 'Source-check date unavailable';
  const date = parseVerifiedInstant(rawDate);
  if (!date || !Number.isFinite(now.getTime()) || date.getTime() > now.getTime()) {
    return { label: unavailableLabel, level: 'unknown', dateStr: null };
  }

  const monthsAgo = (now.getTime() - date.getTime()) / FRESHNESS_MONTH_MS;

  const dateStr = date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

  if (monthsAgo < 6) {
    return { label: `${prefix} ${dateStr}`, level: 'fresh', dateStr };
  }
  if (monthsAgo < 18) {
    return { label: `${prefix} ${dateStr}`, level: 'ok', dateStr };
  }
  return { label: status === 'cross_referenced' ? `Cross-reference may need re-check · ${dateStr}` : `Verified ${dateStr} · may need re-check`, level: 'stale', dateStr };
}

/**
 * Selects the "best available" crisis hotline for a country page.
 * Priority: verified crisis lines first, then verified mental health,
 * then unverified crisis, then anything.
 */
export function getPrioritizedHelp(hotlines: Hotline[]): Hotline | null {
  const priorityCategories: HotlineCategory[] = [
    'suicide_crisis',
    'mental_health',
    'domestic_violence',
    'sexual_violence',
    'child_protection',
    'general_support',
  ];

  // Prefer verified lines in priority category order
  for (const cat of priorityCategories) {
    const found = hotlines.find(
      (h) => h.category === cat && PRIORITIZED_SET.has(h.verification_status)
    );
    if (found) return found;
  }

  // Fall back to unverified lines in priority order
  for (const cat of priorityCategories) {
    const found = hotlines.find((h) => h.category === cat);
    if (found) return found;
  }

  return hotlines[0] ?? null;
}
