import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import SwaggerParser from '@apidevtools/swagger-parser';
const web=resolve(fileURLToPath(new URL('..',import.meta.url))), root=resolve(web,'public/gateway/v1');
const expected=['README.md','artifact-descriptor.schema.json','error.schema.json','health.schema.json','key-record.schema.json','openapi.json','privacy.json','security.json'];
assert.deepEqual(readdirSync(root).sort(),expected); for(const name of expected)assert.ok(lstatSync(resolve(root,name)).isFile()&&!lstatSync(resolve(root,name)).isSymbolicLink());
const ajv=new Ajv2020({strict:true,allErrors:true});addFormats(ajv);
for(const name of expected.filter(n=>n.endsWith('.schema.json')))ajv.compile(JSON.parse(readFileSync(resolve(root,name),'utf8')));
const api=await SwaggerParser.validate(resolve(root,'openapi.json'));assert.equal(api.openapi,'3.1.0');assert.match(api.info.description,/not deployed/i);assert.ok(!Object.keys(api.paths).some(p=>p.includes('latest')));
assert.ok(!Object.hasOwn(api.paths,'/managed/v1/data'));assert.deepEqual(Object.keys(api.paths).sort(),['/managed/v1/health','/managed/v1/manifest','/managed/v1/records','/managed/v1/resolver.js']);
const statuses=(operation)=>Object.keys(operation.responses).sort();
for(const method of ['get','head'])assert.deepEqual(statuses(api.paths['/managed/v1/health'][method]),['200','400','404','503']);
assert.deepEqual(statuses(api.paths['/managed/v1/health'].options),['204','400','404','503']);
for(const path of ['/managed/v1/manifest','/managed/v1/records','/managed/v1/resolver.js']){for(const method of ['get','head'])assert.deepEqual(statuses(api.paths[path][method]),['200','304','400','401','403','404','429','503']);assert.deepEqual(statuses(api.paths[path].options),['204','400','404','503']);}
for(const item of Object.values(api.paths)){for(const method of ['get','head','options'])assert.ok(!Object.hasOwn(item[method].responses,'405'));assert.match(item.description,/405/);}
assert.match(api.info.description,/arbitrary unsupported methods/i);assert.match(api.info.description,/Allow: GET, HEAD, OPTIONS/);
const headers=api.components.headers;for(const name of ['RequestId','CacheControl','ETag','ContentLength','ContentTypeOptions','ContentSecurityPolicy','AllowOrigin','Vary','AllowMethods','AllowHeaders','RateLimitLimit','RateLimitRemaining','RateLimitReset','RetryAfter','Authenticate','Allow'])assert.ok(headers[name],`missing OpenAPI header ${name}`);
for(const name of ['Health','Artifact','NotModified','Preflight','Error'])assert.ok(api.components.responses[name]?.headers,`missing response headers on ${name}`);
assert.match(api.info.description,/bodyless/i);assert.match(api.info.description,/quota token/i);assert.match(api.info.description,/allow-origin/i);assert.equal(api.components.headers.RateLimitReset.schema.maximum,86400);
for(const file of ['README.md','privacy.json','security.json'])assert.match(readFileSync(resolve(root,file),'utf8'),/not[ -]deployed/i);
console.log('Managed gateway contracts OK: exact manifest; Ajv 2020-12 schemas; parsed OpenAPI/runtime status and header parity; explicit foundation status');
