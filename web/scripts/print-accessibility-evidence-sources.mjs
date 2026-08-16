import { resolve } from 'node:path';
import { boundaryEvidence } from './accessibility-evidence-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
const evidence = boundaryEvidence(repo);
console.log('Copy-ready baseline.json sources block:');
console.log(`"sources": ${JSON.stringify({ file_count: evidence.paths.length, digest: evidence.digest })},`);
console.log('');
console.log(`Boundary inventory (${evidence.paths.length} files; informational, do not copy into baseline.json):`);
for (const path of evidence.paths) console.log(path);
