import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INVENTORY_PATH, parseStrictJson, sourceMap } from './security-privacy-evidence-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
const inventory = parseStrictJson(readFileSync(resolve(repo, INVENTORY_PATH)));
console.log(JSON.stringify(sourceMap(repo, Object.keys(inventory.sources)), null, 2));
