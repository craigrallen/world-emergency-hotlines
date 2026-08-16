import { resolve } from 'node:path';
import { loadInventory } from './security-privacy-evidence-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
loadInventory(repo);
console.log('Internal security/privacy evidence inventory OK: strict manifest, finite bound source bytes, closed statuses, checks, categories, and explicit gaps');
