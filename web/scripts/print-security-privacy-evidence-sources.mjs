import { resolve } from 'node:path';
import { loadInventorySourceMap } from './security-privacy-evidence-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
console.log(JSON.stringify(loadInventorySourceMap(repo), null, 2));
