#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { analyzeCompliance, issuePresentation } from './model.mjs';
const [command,path]=process.argv.slice(2); if(!['issue','analyze'].includes(command)||!path) throw new Error('usage: node cli.mjs issue|analyze input.json');
const input=JSON.parse(readFileSync(path,'utf8'));
const out=command==='issue'?issuePresentation(input):analyzeCompliance(input);
process.stdout.write(`${JSON.stringify(out,null,2)}\n`);
