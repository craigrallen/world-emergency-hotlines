// Data adapter.
//
// Phase 1 (current): reads the pre-built JSON shards in /public/data/.
// Phase 2: reads D1 via Astro.locals.runtime.env.HOTLINES_DB when available.
//
// Both paths return the same shape (from types.ts) so pages never care.

import type { Country, Manifest, Hotline } from './types';

const DATA_DIR = new URL('../../public/data/', import.meta.url);

async function readJson<T>(path: URL): Promise<T> {
  const fs = await import('node:fs/promises');
  const text = await fs.readFile(path, 'utf-8');
  return JSON.parse(text) as T;
}

export async function getManifest(): Promise<Manifest> {
  return readJson<Manifest>(new URL('manifest.json', DATA_DIR));
}

export async function getCountry(code: string): Promise<Country | null> {
  const alpha2 = code.toUpperCase();
  try {
    return await readJson<Country>(new URL(`countries/${alpha2}.json`, DATA_DIR));
  } catch (err) {
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

export async function getByCategory(category: string): Promise<Array<{ country: Country; hotlines: Hotline[] }>> {
  const all = await getAllCountries();
  return all
    .map((country) => ({
      country,
      hotlines: country.hotlines.filter((h) => h.category === category),
    }))
    .filter((entry) => entry.hotlines.length > 0);
}
