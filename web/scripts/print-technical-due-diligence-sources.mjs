import { resolve } from 'node:path';
import { currentSourceMap } from './technical-due-diligence-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
console.log(JSON.stringify(currentSourceMap(repo), null, 2));
