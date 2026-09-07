// Hot reload of key records for a running gateway.
//
// `sync-keys` replaces GATEWAY_CONFIG on disk (temp file + rename). A running
// `serve` process watches that file by polling its identity (inode, size, mtime)
// and, on change or SIGHUP, re-reads it and swaps the key set in place through
// gateway.reloadKeys(). Only the `keys` array is reloaded; listen settings,
// artifact roots, and the pepper still need a restart. An unreadable file or an
// invalid record set keeps the last good keys, is logged without details, and is
// retried on the next poll.

import { readFileSync, statSync } from 'node:fs';

export const DEFAULT_RELOAD_SECONDS = 30;
export const MAX_RELOAD_SECONDS = 3600;

/** Parse GATEWAY_KEYS_RELOAD_SECONDS: unset means the default, 0 disables polling (SIGHUP still works). */
export function reloadSecondsFrom(value) {
  if (value === undefined || value === '') return DEFAULT_RELOAD_SECONDS;
  if (typeof value !== 'string' || !/^\d{1,4}$/.test(value)) throw new Error('GATEWAY_KEYS_RELOAD_SECONDS invalid');
  const seconds = Number(value);
  if (seconds > MAX_RELOAD_SECONDS) throw new Error('GATEWAY_KEYS_RELOAD_SECONDS invalid');
  return seconds;
}

export function createKeyReloader({ gateway, configPath, intervalMs = DEFAULT_RELOAD_SECONDS * 1000, log = () => {}, readFile = readFileSync } = {}) {
  if (!gateway || typeof gateway.reloadKeys !== 'function') throw new Error('key reloader requires a gateway');
  if (typeof configPath !== 'string' || configPath.length === 0) throw new Error('key reloader requires a config path');
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > MAX_RELOAD_SECONDS * 1000) throw new Error('key reloader interval out of range');
  if (typeof log !== 'function') throw new Error('key reloader requires a log function');
  if (typeof readFile !== 'function') throw new Error('key reloader requires a readFile function');

  const fingerprint = () => { try { const s = statSync(configPath); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return null; } };
  let last = fingerprint();
  let timer = null;

  /**
   * Reload when the file changed (or when forced). Returns 'unchanged' | 'reloaded' | 'failed'.
   * The accepted fingerprint advances only after a successful reload, so a change whose
   * read or validation failed (a half-written file, a transient error) is retried on
   * every following poll instead of being mistaken for "already applied".
   */
  function check(force = false) {
    const current = fingerprint();
    if (!force && current === last) return 'unchanged';
    let keys;
    try {
      const config = JSON.parse(readFile(configPath, 'utf8'));
      keys = config !== null && typeof config === 'object' && !Array.isArray(config) ? config.keys : undefined;
    } catch { keys = undefined; }
    if (keys === undefined) { log({ event: 'gateway_keys_reload_failed', reason: 'config_unreadable' }); return 'failed'; }
    try {
      const summary = gateway.reloadKeys(keys);
      last = current;
      log({ event: 'gateway_keys_reloaded', ...summary });
      return 'reloaded';
    } catch {
      log({ event: 'gateway_keys_reload_failed', reason: 'keys_invalid' });
      return 'failed';
    }
  }

  return Object.freeze({
    check,
    start() { if (timer !== null || intervalMs === 0) return; timer = setInterval(() => { try { check(); } catch {} }, intervalMs); timer.unref(); },
    stop() { if (timer !== null) clearInterval(timer); timer = null; },
    get polling() { return timer !== null; },
  });
}
