import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { exactObject, plain, SHA256_ID } from './validation.mjs';

export const ARTIFACT_ROUTES = Object.freeze({
  '/managed/v1/manifest': Object.freeze({ permission:'manifest', class:'manifest', publicPath:'/api/v1/manifest.json', contentType:'application/json; charset=utf-8' }),
  '/managed/v1/records': Object.freeze({ permission:'records', class:'records', publicPath:'/api/v1/records.json', contentType:'application/json; charset=utf-8' }),
  '/managed/v1/resolver.js': Object.freeze({ permission:'resolver', class:'resolver', publicPath:'/api/v1/resolver.js', contentType:'text/javascript; charset=utf-8' }),
});
const ROUTES = Object.keys(ARTIFACT_ROUTES);
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const INDEX_SEMANTICS='Each sha256 value identifies the exact bytes served at path for this generated release. Paths are mutable deployment locations.';
const COVERAGE=['/data/**','/api/v1/**','/widget/v1/hotlines-widget.js','/release/v1/changes.json','/release/v1/changes/**','/feeds/**','/subscriptions/v1/**','/gateway/v1/**'];
const EXCLUDES=['/release/v1/artifacts.json','/release/v1/release.json'];
const RELATIONSHIP_PATHS=['/data/manifest.json','/api/v1/manifest.json','/api/v1/records.json','/api/v1/resolver.js','/widget/v1/hotlines-widget.js','/data/metadata-coverage.json','/data/categories-stats.json','/data/search-index.json','/release/v1/changes.json','/release/v1/changes/latest.json','/feeds/releases.json','/feeds/releases.rss','/feeds/releases.atom','/subscriptions/v1/README.md','/subscriptions/v1/common.schema.json','/subscriptions/v1/event.schema.json','/subscriptions/v1/subscription-request.schema.json','/subscriptions/v1/subscription-response.schema.json','/subscriptions/v1/error.schema.json','/subscriptions/v1/openapi.json','/subscriptions/v1/webhook-contract.json','/subscriptions/v1/fixture-baseline.json','/subscriptions/v1/fixture-no-change.json','/subscriptions/v1/fixture-added.json','/subscriptions/v1/fixture-modified.json','/subscriptions/v1/fixture-country-metadata.json','/gateway/v1/README.md','/gateway/v1/artifact-descriptor.schema.json','/gateway/v1/error.schema.json','/gateway/v1/health.schema.json','/gateway/v1/key-record.schema.json','/gateway/v1/openapi.json','/gateway/v1/privacy.json','/gateway/v1/security.json'];
const BUILD_INPUTS={integration_generator:['scripts/build-static-data.mjs','scripts/centroids.json','scripts/dataset-diff.mjs','scripts/generate-gateway-contracts.mjs','scripts/generate-subscription-contracts.mjs','scripts/metadata-coverage.mjs','scripts/release-feeds.mjs','scripts/release-integrity.mjs','scripts/subscription-events.mjs'],resolver_code:['src/lib/finder.js'],widget_code:['public/widget/v1/hotlines-widget.js']};
const GENERATED_AT_SEMANTICS='Release identity is derived from deterministic content and code identities, not wall-clock build metadata.';
const BUILD_SEMANTICS='SHA-256 over the listed ordered source files, each framed by UTF-8 path length/path and byte length. These identities cover only their finite inputs.';
const CLAIM_SCOPE='Only the listed major-version combinations are exercised by repository verification.';
const CHECKSUM_SEMANTICS='Unsigned SHA-256 checksums detect byte mismatch after a descriptor is obtained through a trusted channel; they do not prove publisher identity or freshness.';
const RELEASE_ID_SEMANTICS='Identity of canonical origin, dataset bytes, finite build inputs, declared compatibility, and the non-circular exact-byte artifact-index digest.';
const sameJson=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;return JSON.stringify(value);}
function artifactEntry(entry){return exactObject(entry,['path','sha256','bytes'])&&typeof entry.path==='string'&&entry.path.startsWith('/')&&!entry.path.includes('?')&&!entry.path.includes('#')&&SHA256_ID.test(entry.sha256)&&Number.isSafeInteger(entry.bytes)&&entry.bytes>=0;}
function coveredArtifactPath(path){return path.startsWith('/data/')||path.startsWith('/api/v1/')||path==='/widget/v1/hotlines-widget.js'||path==='/release/v1/changes.json'||path.startsWith('/release/v1/changes/')||path.startsWith('/feeds/')||path.startsWith('/subscriptions/v1/')||path.startsWith('/gateway/v1/');}
function validateTrustedRelease(release,index){
  const releaseKeys=['schema_version','canonical_origin','dataset_version','generated_at','generated_at_semantics','build_versions','build_version_semantics','compatibility','relationships','artifact_index','checksum_semantics','mutable_paths','release_id','release_id_semantics'];
  if(!exactObject(index,['schema_version','semantics','artifacts'])||index.schema_version!=='1.0'||index.semantics!==INDEX_SEMANTICS||!Array.isArray(index.artifacts)||index.artifacts.length<1)throw new Error('invalid trusted release input');
  let previous='';const byPath=new Map();for(const entry of index.artifacts){if(!artifactEntry(entry)||!coveredArtifactPath(entry.path)||EXCLUDES.includes(entry.path)||entry.path<=previous||byPath.has(entry.path))throw new Error('invalid trusted release input');previous=entry.path;byPath.set(entry.path,entry);}
  if(!exactObject(release,releaseKeys)||release.schema_version!=='1.0'||release.canonical_origin!=='https://worldhotlines.org'||!SHA256_ID.test(release.dataset_version)||release.generated_at!==null||release.generated_at_semantics!==GENERATED_AT_SEMANTICS||release.checksum_semantics!==CHECKSUM_SEMANTICS||release.mutable_paths!==true||release.release_id_semantics!==RELEASE_ID_SEMANTICS||!SHA256_ID.test(release.release_id))throw new Error('invalid trusted release input');
  if(!exactObject(release.build_versions,['integration_generator','resolver_code','widget_code'])||!Object.values(release.build_versions).every(v=>SHA256_ID.test(v))||!exactObject(release.build_version_semantics,['algorithm','inputs'])||release.build_version_semantics.algorithm!==BUILD_SEMANTICS||!sameJson(release.build_version_semantics.inputs,BUILD_INPUTS))throw new Error('invalid trusted release input');
  const c=release.compatibility;if(!exactObject(c,['api','resolver','widget','claim_scope'])||!exactObject(c.api,['major'])||c.api.major!==1||!exactObject(c.resolver,['major','tested_api_majors'])||c.resolver.major!==1||!sameJson(c.resolver.tested_api_majors,[1])||!exactObject(c.widget,['major','tested_api_majors','tested_resolver_majors'])||c.widget.major!==1||!sameJson(c.widget.tested_api_majors,[1])||!sameJson(c.widget.tested_resolver_majors,[1])||c.claim_scope!==CLAIM_SCOPE)throw new Error('invalid trusted release input');
  const ai=release.artifact_index;if(!exactObject(ai,['path','sha256','artifact_count','coverage','excludes'])||ai.path!=='/release/v1/artifacts.json'||!SHA256_ID.test(ai.sha256)||ai.artifact_count!==index.artifacts.length||!sameJson(ai.coverage,COVERAGE)||!sameJson(ai.excludes,EXCLUDES))throw new Error('invalid trusted release input');
  if(!exactObject(release.relationships,RELATIONSHIP_PATHS))throw new Error('invalid trusted release input');for(const path of RELATIONSHIP_PATHS){const relationship=release.relationships[path],entry=byPath.get(path);if(!artifactEntry(relationship)||!entry||!sameJson(relationship,entry))throw new Error('release artifact relationship mismatch');}
  const identity={schema_version:'1.0',canonical_origin:'https://worldhotlines.org',dataset_version:release.dataset_version,build_versions:release.build_versions,compatibility:release.compatibility,artifact_index_sha256:ai.sha256};if(release.release_id!==digest(Buffer.from(stableJson(identity))))throw new Error('release identity mismatch');
  return byPath;
}

export function descriptorFromRelease(release, index) {
  if (!plain(release) || !plain(index)) throw new Error('invalid trusted release input');
  const byPath = validateTrustedRelease(release,index);
  const artifacts = {};
  for (const route of ROUTES) {
    const spec=ARTIFACT_ROUTES[route], entry=byPath.get(spec.publicPath), relationship=release.relationships?.[spec.publicPath];
    if (!entry || !relationship || JSON.stringify(entry) !== JSON.stringify(relationship)) throw new Error('release artifact relationship mismatch');
    artifacts[route]={ path:spec.publicPath.slice(1), sha256:entry.sha256, bytes:entry.bytes, content_type:spec.contentType };
  }
  return { schema_version:'1.0', release_id:release.release_id, dataset_version:release.dataset_version, artifact_index_sha256:release.artifact_index?.sha256, artifacts };
}
export function descriptorFromReleaseBytes(releaseBytes,indexBytes){
  if(!Buffer.isBuffer(releaseBytes)||!Buffer.isBuffer(indexBytes))throw new Error('invalid trusted release input');
  let release,index;try{release=JSON.parse(releaseBytes);index=JSON.parse(indexBytes);}catch{throw new Error('invalid trusted release input');}
  if(release.artifact_index?.sha256!==digest(indexBytes))throw new Error('artifact index digest mismatch');
  return descriptorFromRelease(release,index);
}

function validateDescriptor(descriptor, releaseId, datasetVersion) {
  if (!exactObject(descriptor,['schema_version','release_id','dataset_version','artifact_index_sha256','artifacts']) || descriptor.schema_version !== '1.0' || descriptor.release_id !== releaseId || descriptor.dataset_version !== datasetVersion || !SHA256_ID.test(descriptor.artifact_index_sha256) || !exactObject(descriptor.artifacts,ROUTES)) throw new Error('invalid artifact descriptor');
  for (const route of ROUTES) {
    const entry=descriptor.artifacts[route], spec=ARTIFACT_ROUTES[route];
    if (!exactObject(entry,['path','sha256','bytes','content_type']) || entry.path !== spec.publicPath.slice(1) || !SHA256_ID.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 64*1024*1024 || entry.content_type !== spec.contentType) throw new Error('invalid artifact descriptor');
  }
}
function identity(meta){ return {dev:meta.dev,ino:meta.ino}; }
function same(meta,pin){ return meta.dev===pin.dev&&meta.ino===pin.ino; }
function components(path) {
  const absolute=resolve(path), parts=absolute.split(sep).filter(Boolean); let cursor=isAbsolute(absolute)?sep:''; const out=[];
  for(const part of parts){cursor=resolve(cursor,part);out.push(cursor);} return out;
}
function pinPath(path, expectFile=false) {
  const pins=[];
  for(const component of components(path)){const meta=lstatSync(component);if(meta.isSymbolicLink())throw new Error('unsafe artifact path');pins.push({path:component,...identity(meta)});}
  const last=lstatSync(path); if(expectFile?!last.isFile():!last.isDirectory())throw new Error('unsafe artifact path'); return pins;
}

export function createArtifactStore({ root, descriptor, releaseId, datasetVersion }) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('invalid artifact root');
  validateDescriptor(descriptor,releaseId,datasetVersion);
  const canonical=realpathSync(root); if(canonical!==resolve(root))throw new Error('unsafe artifact root');
  const rootPins=pinPath(canonical), rootPin=rootPins.at(-1), files=new Map();
  for(const route of ROUTES){const entry=descriptor.artifacts[route], path=resolve(canonical,entry.path);if(relative(canonical,path).startsWith('..'))throw new Error('unsafe artifact path');const pins=pinPath(path,true);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const meta=fstatSync(fd),bytes=readFileSync(fd);if(!same(meta,pins.at(-1))||bytes.length!==entry.bytes||digest(bytes)!==entry.sha256)throw new Error('artifact identity mismatch');files.set(route,{entry,path,pins,pin:identity(meta)});}finally{closeSync(fd);}}
  function verifyPins(pins){for(const pin of pins){const meta=lstatSync(pin.path);if(meta.isSymbolicLink()||!same(meta,pin))throw new Error('artifact replaced');}}
  return { read(route){verifyPins(rootPins);const file=files.get(route);verifyPins(file.pins);const fd=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const meta=fstatSync(fd),bytes=readFileSync(fd);if(!meta.isFile()||!same(meta,file.pin)||bytes.length!==file.entry.bytes||digest(bytes)!==file.entry.sha256)throw new Error('artifact replaced');return bytes;}finally{closeSync(fd);}}, rootIdentity:rootPin };
}
