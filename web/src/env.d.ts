/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_SITE_NAME: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Augment Astro locals so `Astro.locals.runtime.env.HOTLINES_DB` is typed
// once we flip to hybrid/SSR on Cloudflare Pages.
declare namespace App {
  interface Locals {
    runtime?: {
      env: {
        HOTLINES_DB?: D1Database;
        AI?: unknown;
      };
    };
  }
}

// Minimal D1 shim so code compiles in static mode without @cloudflare/workers-types
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}
