import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {cpSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,rmSync,symlinkSync,unlinkSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {resolve} from 'node:path';import net from 'node:net';import {spawnSync} from 'node:child_process';
import {createGateway,EVENT_KEYS,ifNoneMatchMatches} from '../src/gateway.mjs';import {authenticate,createKey,verifier,redact} from '../src/security.mjs';import {MemoryTokenBuckets} from '../src/quota.mjs';import {descriptorFromRelease,descriptorFromReleaseBytes} from '../src/artifacts.mjs';
import {verifyGatewayContractDrift} from '../../web/scripts/generate-gateway-contracts.mjs';
const pepper='synthetic-test-pepper-with-32-chars',hash=`sha256:${'a'.repeat(64)}`;
const sha=(bytes)=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function fixture(){const root=realpathSync(mkdtempSync(resolve(tmpdir(),'weh-gateway-')));mkdirSync(resolve(root,'api/v1'),{recursive:true});const values={'manifest.json':'{"ok":true}\n','records.json':'[]\n','resolver.js':'export const ok=true;\n'},artifacts={};for(const[name,value]of Object.entries(values)){const bytes=Buffer.from(value),path=`api/v1/${name}`,route=name==='manifest.json'?'/managed/v1/manifest':name==='records.json'?'/managed/v1/records':'/managed/v1/resolver.js';writeFileSync(resolve(root,path),bytes);artifacts[route]={path,sha256:sha(bytes),bytes:bytes.length,content_type:name.endsWith('.js')?'text/javascript; charset=utf-8':'application/json; charset=utf-8'};}return{root,descriptor:{schema_version:'1.0',release_id:hash,dataset_version:hash,artifact_index_sha256:hash,artifacts},values};}
function record(raw,id,extra={}){return{id,verifier:verifier(raw,pepper),state:'active',not_before:null,expires_at:null,api_majors:[1],permissions:['manifest','records','resolver'],quota:{rate:10,burst:20},synthetic:true,...extra};}
function config(extra={}){const key=createKey(),files=fixture();return{key,files,value:{artifactRoot:files.root,artifactDescriptor:files.descriptor,pepper,releaseId:hash,datasetVersion:hash,keys:[record(key.raw,key.id)],origins:['https://synthetic.invalid'],...extra}};}
async function start(extra={}){const c=config(extra),events=[];if(!Object.hasOwn(extra,'sink'))c.value.sink=e=>events.push(e);const gateway=createGateway(c.value);await gateway.listen();return{...c,gateway,events,base:`http://127.0.0.1:${gateway.server.address().port}`};}
const auth=raw=>({authorization:`Bearer ${raw}`});

test('closed startup validation rejects malformed configuration and key records',()=>{const good=config();const bad=[null,[],{...good.value,wat:true},{...good.value,pepper:'short'},{...good.value,releaseId:'nope'},{...good.value,origins:['http://bad.example']},{...good.value,origins:['https://ok.example/']},{...good.value,origins:['https://synthetic.invalid','https://synthetic.invalid']},{...good.value,maxConcurrent:0},{...good.value,keys:[]},{...good.value,keys:[{...good.value.keys[0],unknown:true}]},{...good.value,keys:[{...good.value.keys[0],verifier:'A'.repeat(42)}]},{...good.value,keys:[{...good.value.keys[0],id:'ABCDEF123456'}]},{...good.value,keys:[{...good.value.keys[0],state:'disabled'}]},{...good.value,keys:[{...good.value.keys[0],not_before:'nonsense'}]},{...good.value,keys:[{...good.value.keys[0],expires_at:'2025-02-29T00:00:00Z'}]},{...good.value,keys:[{...good.value.keys[0],not_before:'2030-01-01T00:00:00Z',expires_at:'2029-01-01T00:00:00Z'}]},{...good.value,keys:[{...good.value.keys[0],permissions:[]}]},{...good.value,keys:[{...good.value.keys[0],permissions:['manifest','manifest']}]},{...good.value,keys:[{...good.value.keys[0],api_majors:[2]}]},{...good.value,keys:[{...good.value.keys[0],quota:{rate:Infinity,burst:1}}]}];for(const value of bad)assert.throws(()=>createGateway(value),/invalid/i);const duplicate={...good.value,keys:[good.value.keys[0],{...good.value.keys[0],state:'revoked'}]};assert.throws(()=>createGateway(duplicate),/invalid/i);assert.throws(()=>createGateway({...good.value,mode:'production',host:'0.0.0.0',origins:[],keys:[{...good.value.keys[0],synthetic:true}]}),/invalid/i);});

test('key lifecycle is canonical, uniform, and rotation requires distinct ids',async()=>{const key=createKey(),second=createKey(),now=Date.parse('2038-01-01T00:00:00.000Z'),g=await start({now:()=>now,keys:[record(key.raw,key.id),record(second.raw,second.id)]});try{for(const value of [undefined,'Bearer malformed',`Bearer ${createKey().raw}`])assert.equal((await fetch(`${g.base}/managed/v1/manifest`,{headers:value?{authorization:value}:{}})).status,401);assert.equal((await fetch(`${g.base}/managed/v1/manifest`,{headers:auth(second.raw)})).status,200);}finally{await g.gateway.close();}for(const patch of [{state:'revoked'},{state:'expired'},{expires_at:'2037-01-01T00:00:00.000Z'},{not_before:'2039-01-01T00:00:00.000Z'}]){const x=await start({now:()=>now,keys:[record(key.raw,key.id,patch)]});try{assert.equal((await fetch(`${x.base}/managed/v1/manifest`,{headers:auth(key.raw)})).status,401);}finally{await x.gateway.close();}}});

test('exact routes, bytes, CORS on success/errors/304, and exact OPTIONS contract',async()=>{const g=await start();const origin='https://synthetic.invalid';try{let r=await fetch(`${g.base}/managed/v1/manifest`,{headers:{...auth(g.key.raw),origin}});assert.equal(r.status,200);assert.equal(await r.text(),g.files.values['manifest.json']);assert.equal(r.headers.get('access-control-allow-origin'),origin);const etag=r.headers.get('etag'),initialRemaining=Number(r.headers.get('ratelimit-remaining'));for(const candidate of [etag,'*',`W/${etag}`,`"other", ${etag}`]){r=await fetch(`${g.base}/managed/v1/manifest`,{headers:{...auth(g.key.raw),origin,'if-none-match':candidate}});assert.equal(r.status,304);assert.equal(await r.text(),'');assert.equal(r.headers.get('etag'),etag);assert.equal(r.headers.get('cache-control'),'public, max-age=300, stale-while-revalidate=86400');assert.equal(r.headers.get('access-control-allow-origin'),origin);assert.ok(r.headers.get('x-request-id'));assert.match(r.headers.get('ratelimit-reset'),/^\d+$/);}assert.equal(Number(r.headers.get('ratelimit-remaining')),initialRemaining-4);r=await fetch(`${g.base}/managed/v1/manifest`,{method:'HEAD',headers:{...auth(g.key.raw),origin}});assert.equal(r.status,200);assert.equal(await r.text(),'');assert.equal(Number(r.headers.get('ratelimit-remaining')),initialRemaining-5);r=await fetch(`${g.base}/managed/v1/manifest`,{headers:{...auth(g.key.raw),origin,'if-none-match':`${etag}, broken`}});assert.equal(r.status,200);for(const statusCase of [{url:'/managed/v1/manifest',headers:{origin},status:401},{url:'/managed/v1/records',headers:{...auth(g.key.raw),origin},status:200}])assert.equal((await fetch(g.base+statusCase.url,{headers:statusCase.headers})).status,statusCase.status);r=await fetch(`${g.base}/managed/v1/manifest`,{method:'OPTIONS',headers:{origin}});assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),origin);assert.equal((await fetch(`${g.base}/managed/v1/manifest`,{method:'OPTIONS',headers:{origin:'https://denied.invalid'}})).headers.get('access-control-allow-origin'),null);for(const path of ['/managed/v1/data','/managed/v2/manifest','/managed/v1/manifest?q=x'])assert.equal((await fetch(g.base+path,{method:'OPTIONS'})).status,404);r=await fetch(`${g.base}/managed/v1/manifest`,{method:'POST',headers:{origin}});assert.equal(r.status,405);assert.equal(r.headers.get('allow'),'GET, HEAD, OPTIONS');assert.equal((await fetch(`${g.base}/managed/v1/unknown`,{method:'POST'})).status,404);assert.equal((await fetch(`${g.base}/managed/v1/manifest?q=x`,{method:'POST'})).status,404);}finally{await g.gateway.close();}});

test('quota validates policy, reverse clocks, overflow, and malformed stores fail closed',async()=>{for(const quota of [{rate:0,burst:1},{rate:-1,burst:1},{rate:NaN,burst:1},{rate:Infinity,burst:1},{rate:1,burst:0},{rate:1,burst:1.5},{rate:1001,burst:1},{rate:1,burst:10001}])assert.throws(()=>new MemoryTokenBuckets().take('x',quota));assert.throws(()=>new MemoryTokenBuckets({maxKeys:0}));assert.throws(()=>new MemoryTokenBuckets({idleMs:Infinity}));let t=1000;const q=new MemoryTokenBuckets({now:()=>t,maxKeys:1,idleMs:1000});assert.equal(q.take('a',{rate:1,burst:1}).ok,true);t=0;const limited=q.take('a',{rate:1,burst:1});assert.equal(limited.ok,false);assert.deepEqual([limited.retryAfter,limited.reset],[1,1]);for(const output of [null,{ok:true,limit:NaN,remaining:0,reset:0},{ok:true,limit:1,remaining:-1,reset:0},{ok:false,limit:1,remaining:0,reset:Infinity,retryAfter:1}]){const g=await start({quotaStore:{take:()=>output}});try{assert.equal((await fetch(`${g.base}/managed/v1/manifest`,{headers:auth(g.key.raw)})).status,503);}finally{await g.gateway.close();}}});

test('artifact descriptor and pinned filesystem identity fail closed',async()=>{const c=config();assert.throws(()=>createGateway({...c.value,artifactDescriptor:{...c.files.descriptor,release_id:`sha256:${'b'.repeat(64)}`}}));const entry=c.files.descriptor.artifacts['/managed/v1/manifest'];assert.throws(()=>createGateway({...c.value,artifactDescriptor:{...c.files.descriptor,artifacts:{...c.files.descriptor.artifacts,'/managed/v1/manifest':{...entry,sha256:`sha256:${'b'.repeat(64)}`}}}}));const g=await start();try{const path=resolve(g.files.root,'api/v1/manifest.json'),replacement=`${path}.new`;writeFileSync(replacement,g.files.values['manifest.json']);renameSync(replacement,path);assert.equal((await fetch(`${g.base}/managed/v1/manifest`,{headers:auth(g.key.raw)})).status,503);}finally{await g.gateway.close();}const s=config(),real=s.files.root,link=`${real}-link`;symlinkSync(real,link);assert.throws(()=>createGateway({...s.value,artifactRoot:link}),/unsafe/i);});

test('throwing sinks are isolated and events have exact safe fields',async()=>{let failures=0;const events=[],g=await start({sink(event){events.push(event);throw new Error('sink');},sinkError(count){failures=count;}});try{for(const path of ['/managed/v1/health','/managed/v1/manifest'])await fetch(g.base+path,{headers:auth(g.key.raw)});await new Promise(r=>setTimeout(r,10));assert.equal(failures,2);assert.equal(g.gateway.sinkErrors,2);assert.deepEqual(Object.keys(events[0]),EVENT_KEYS);const encoded=JSON.stringify(events);assert.equal(encoded.includes(g.key.raw),false);assert.equal(encoded.includes(g.key.id),false);assert.equal((await fetch(`${g.base}/managed/v1/health`)).status,200);}finally{await g.gateway.close();}});

function raw(port,payload){return new Promise((ok,no)=>{let data='';const socket=net.createConnection({host:'127.0.0.1',port},()=>socket.write(payload));socket.setEncoding('utf8');socket.on('data',chunk=>data+=chunk);socket.on('end',()=>ok(data));socket.on('error',no);});}
test('body framing is rejected, connection closes, overload and shutdown are bounded',async()=>{const g=await start({maxConcurrent:1,shutdownTimeoutMs:200});const port=g.gateway.server.address().port;try{for(const framing of ['Content-Length: 1\r\n','Transfer-Encoding: chunked\r\n','Content-Length: 1\r\nTransfer-Encoding: chunked\r\n']){const response=await raw(port,`GET /managed/v1/health HTTP/1.1\r\nHost: x\r\n${framing}\r\n`);assert.match(response,/400|clientError/i);assert.match(response,/Connection: close/i);}assert.equal((await fetch(`${g.base}/managed/v1/health`,{headers:{'content-length':'0'}})).status,200);}finally{await g.gateway.close();}await assert.rejects(fetch(`${g.base}/managed/v1/health`));});

test('actual generated release descriptor integrates with canonical public artifacts',()=>{const root=resolve(import.meta.dirname,'../../web/public'),releaseBytes=readFileSync(resolve(root,'release/v1/release.json')),indexBytes=readFileSync(resolve(root,'release/v1/artifacts.json')),release=JSON.parse(releaseBytes),descriptor=descriptorFromReleaseBytes(releaseBytes,indexBytes),key=createKey();assert.throws(()=>descriptorFromReleaseBytes(releaseBytes,Buffer.concat([indexBytes,Buffer.from(' ')])),/digest/);const gateway=createGateway({artifactRoot:root,artifactDescriptor:descriptor,pepper,releaseId:release.release_id,datasetVersion:release.dataset_version,keys:[record(key.raw,key.id)],origins:[]});assert.ok(gateway.server);});

test('all trusted-release profiles are accepted and adjacent hybrids are rejected', () => {
  const root = resolve(import.meta.dirname, '../../web/public/release/v1');
  const current = {
    release: JSON.parse(readFileSync(resolve(root, 'release.json'))),
    index: JSON.parse(readFileSync(resolve(root, 'artifacts.json'))),
  };
  const encode = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const stable = (value) => Array.isArray(value)
    ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
      : JSON.stringify(value);
  const finalize = ({ release, index }) => {
    release.artifact_index.artifact_count = index.artifacts.length;
    const indexBytes = encode(index);
    release.artifact_index.sha256 = sha(indexBytes);
    release.release_id = sha(Buffer.from(stable({
      schema_version: '1.0',
      canonical_origin: 'https://worldhotlines.org',
      dataset_version: release.dataset_version,
      build_versions: release.build_versions,
      compatibility: release.compatibility,
      artifact_index_sha256: release.artifact_index.sha256,
    })));
    return { release, index, indexBytes };
  };
  const without = (source, { namespace, coverage, buildInputs, artifacts = [] }) => {
    const release = structuredClone(source.release);
    const index = structuredClone(source.index);
    index.artifacts = index.artifacts.filter(({ path }) => !path.startsWith(namespace) && !artifacts.includes(path));
    for (const path of Object.keys(release.relationships)) if (path.startsWith(namespace) || artifacts.includes(path)) delete release.relationships[path];
    release.artifact_index.coverage = release.artifact_index.coverage.filter((entry) => entry !== coverage);
    release.build_version_semantics.inputs.integration_generator =
      release.build_version_semantics.inputs.integration_generator.filter((entry) => !buildInputs.includes(entry));
    return finalize({ release, index });
  };
  const pwaPaths = ['/manifest.webmanifest', '/offline.html', '/pwa-register.js', '/service-worker.js', '/pwa-icon-512.png'];
  const asPrePwa = (source) => {
    const release = structuredClone(source.release);
    const index = structuredClone(source.index);
    index.artifacts = index.artifacts.filter(({ path }) => !pwaPaths.includes(path));
    release.artifact_index.coverage = release.artifact_index.coverage.filter((path) => !pwaPaths.includes(path));
    delete release.build_versions.offline_shell;
    delete release.build_version_semantics.inputs.offline_shell;
    return finalize({ release, index });
  };
  const profiles = [
    ['current', finalize(structuredClone(current)), null],
  ];
  profiles.push(['evidence', without(profiles.at(-1)[1], {
    namespace: '/evidence-backed-coverage/v1/', coverage: '/evidence-backed-coverage/v1/**',
    artifacts: ['/api/v1/traveler-cards.json.gz'],
    buildInputs: ['scripts/api-records-transform.mjs', 'src/lib/traveler.js', 'scripts/generate-evidence-backed-coverage-contracts.mjs', 'repo:evidence-backed-coverage/model.mjs'],
  }), '/evidence-backed-coverage/v1/README.md']);
  profiles.push(['plan', without(profiles.at(-1)[1], {
    namespace: '/deprecation-proposals/v1/', coverage: '/deprecation-proposals/v1/**',
    buildInputs: ['scripts/generate-deprecation-proposal-contracts.mjs', 'repo:deprecation-proposals/model.mjs'],
  }), '/deprecation-proposals/v1/README.md']);
  profiles.push(['reviewer', without(profiles.at(-1)[1], {
    namespace: '/managed-api-plans/v1/', coverage: '/managed-api-plans/v1/**',
    buildInputs: ['scripts/generate-managed-api-plan-contracts.mjs', 'repo:managed-api-plans/model.mjs'],
  }), '/managed-api-plans/v1/README.md']);
  profiles.push(['provider', without(profiles.at(-1)[1], {
    namespace: '/reviewer-work-queue/v1/', coverage: '/reviewer-work-queue/v1/**',
    buildInputs: ['scripts/generate-reviewer-work-queue-contracts.mjs', 'repo:reviewer-work-queue/model.mjs'],
  }), '/reviewer-work-queue/v1/README.md']);
  profiles.push(['assurance', without(profiles.at(-1)[1], {
    namespace: '/provider-claims/v1/', coverage: '/provider-claims/v1/**',
    buildInputs: ['scripts/generate-provider-claim-contracts.mjs', 'repo:provider-claims/model.mjs'],
  }), '/provider-claims/v1/README.md']);
  profiles.push(['technical', without(profiles.at(-1)[1], {
    namespace: '/assurance-packs/v1/', coverage: '/assurance-packs/v1/**',
    buildInputs: ['scripts/generate-assurance-pack-contracts.mjs', 'repo:assurance-packs/model.mjs'],
  }), '/assurance-packs/v1/README.md']);
  profiles.push(['managed', without(profiles.at(-1)[1], {
    namespace: '/technical-health/v1/', coverage: '/technical-health/v1/**',
    buildInputs: ['scripts/generate-technical-health-contracts.mjs', 'repo:technical-health/model.mjs'],
  }), '/technical-health/v1/README.md']);
  profiles.push(['organization', without(profiles.at(-1)[1], {
    namespace: '/managed-widget-config/v1/', coverage: '/managed-widget-config/v1/**',
    buildInputs: ['scripts/generate-managed-widget-config-contracts.mjs', 'repo:managed-widget-config/model.mjs'],
  }), '/managed-widget-config/v1/README.md']);
  profiles.push(['legacy', without(profiles.at(-1)[1], {
    namespace: '/organizations/v1/', coverage: '/organizations/v1/**',
    buildInputs: ['scripts/generate-organization-contracts.mjs', 'repo:control-plane/model.mjs'],
  }), '/organizations/v1/README.md']);

  for (const [name, profile] of profiles) {
    assert.ok(descriptorFromReleaseBytes(encode(profile.release), profile.indexBytes), `${name} profile rejected`);
    const prePwa = asPrePwa(profile);
    assert.ok(prePwa.index.artifacts.every(({ path }) => !pwaPaths.includes(path)), `${name} pre-PWA index retained a PWA artifact`);
    assert.ok(prePwa.release.artifact_index.coverage.every((path) => !pwaPaths.includes(path)), `${name} pre-PWA coverage retained a PWA path`);
    assert.equal(Object.hasOwn(prePwa.release.build_versions, 'offline_shell'), false, `${name} pre-PWA build versions retained offline_shell`);
    assert.equal(Object.hasOwn(prePwa.release.build_version_semantics.inputs, 'offline_shell'), false, `${name} pre-PWA build inputs retained offline_shell`);
    assert.ok(descriptorFromReleaseBytes(encode(prePwa.release), prePwa.indexBytes), `${name} true pre-PWA profile rejected`);
  }
  for (let i = 1; i < profiles.length; i++) {
    const [name, lower, adjacentPath] = profiles[i];
    const upper = profiles[i - 1][1];
    const hybrid = structuredClone(lower.release);
    hybrid.relationships[adjacentPath] = upper.release.relationships[adjacentPath];
    assert.throws(() => descriptorFromRelease(hybrid, lower.index), /invalid/, `${name} adjacent hybrid accepted`);
  }
  const travelerHybrid = structuredClone(profiles[1][1].release);
  travelerHybrid.relationships['/api/v1/traveler-cards.json.gz'] = current.release.relationships['/api/v1/traveler-cards.json.gz'];
  assert.throws(() => descriptorFromRelease(travelerHybrid, profiles[1][1].index), /invalid/, 'traveler-card adjacent hybrid accepted');
});

test('trusted release validation rejects complete-envelope tampering',()=>{const root=resolve(import.meta.dirname,'../../web/public/release/v1'),baseRelease=JSON.parse(readFileSync(resolve(root,'release.json'))),baseIndex=JSON.parse(readFileSync(resolve(root,'artifacts.json'))),encode=value=>Buffer.from(`${JSON.stringify(value,null,2)}\n`),attempt=(mutateRelease=()=>{},mutateIndex=()=>{})=>{const release=structuredClone(baseRelease),index=structuredClone(baseIndex);mutateIndex(index);const indexBytes=encode(index);release.artifact_index.sha256=sha(indexBytes);mutateRelease(release,index);assert.throws(()=>descriptorFromReleaseBytes(encode(release),indexBytes));};const unrelated=baseIndex.artifacts.findIndex(e=>e.path==='/data/manifest.json');attempt(()=>{},i=>i.artifacts[unrelated].bytes++);attempt(r=>r.artifact_index.path='/evil');attempt(r=>r.artifact_index.artifact_count++);attempt(r=>r.artifact_index.coverage=[...r.artifact_index.coverage,'/evil/**']);attempt(r=>r.artifact_index.excludes=[]);attempt(r=>r.artifact_index.sha256=hash);attempt(r=>r.release_id=hash);attempt(r=>r.dataset_version=hash);attempt(r=>r.schema_version='2.0');attempt(r=>r.unknown=true);attempt(r=>r.relationships['/data/manifest.json'].bytes++);attempt(r=>delete r.relationships['/data/manifest.json']);attempt(r=>r.relationships['/unknown']={path:'/unknown',sha256:hash,bytes:1});attempt(()=>{},i=>i.artifacts.reverse());attempt(()=>{},i=>i.artifacts.push({...i.artifacts[0]}));attempt(()=>{},i=>{i.artifacts.push({path:'/unknown',sha256:hash,bytes:1});i.artifacts.sort((a,b)=>a.path.localeCompare(b.path));});const polluted=Object.assign(Object.create({evil:true}),baseRelease);assert.throws(()=>descriptorFromRelease(polluted,baseIndex));});

test('authenticate is mode-aware and fail closed as a direct exported boundary',()=>{const key=createKey(),synthetic=record(key.raw,key.id),production={...synthetic,synthetic:false},syntheticMap=new Map([[key.id,synthetic]]),productionMap=new Map([[key.id,production]]),header=`Bearer ${key.raw}`,now=Date.now();assert.equal(authenticate(header,syntheticMap,pepper).ok,false);assert.equal(authenticate(header,syntheticMap,pepper,'production',now).ok,false);assert.equal(authenticate(header,syntheticMap,pepper,'synthetic',now).ok,true);assert.equal(authenticate(header,syntheticMap,pepper,'invalid',now).ok,false);assert.equal(authenticate(header,productionMap,pepper,'production',now).ok,true);for(const value of [NaN,Infinity,-Infinity])assert.equal(authenticate(header,syntheticMap,pepper,'synthetic',value).ok,false);for(const records of [null,{},new Map([[key.id,{...synthetic,expires_at:'garbage'}]]),new Map([[key.id,{...synthetic,verifier:'bad'}]]),new Map([[key.id,{...synthetic,quota:{rate:0.001,burst:10000}}]]),new Map([[key.id,{...synthetic,state:'unknown'}]]),new Map([[key.id,{...synthetic,permissions:['manifest','wat']}]]),new Map([[key.id,{...synthetic,api_majors:[2]}]]),new Map([[key.id,Object.assign(Object.create({evil:true}),synthetic)]])])assert.equal(authenticate(header,records,pepper,'synthetic',now).ok,false);});

test('quota policy boundaries keep every reset header representable',()=>{for(const policy of [{rate:1/86400,burst:1},{rate:10000/86400,burst:10000},{rate:1000,burst:10000}]){let now=0;const store=new MemoryTokenBuckets({now:()=>now});for(let i=0;i<policy.burst;i++)assert.equal(store.take('x',policy).ok,true);const exhausted=store.take('x',policy);assert.equal(exhausted.ok,false);assert.ok(exhausted.reset<=86400);now+=Math.ceil(1000/policy.rate);assert.equal(store.take('x',policy).ok,true);}for(const policy of [{rate:(1/86400)*(1-Number.EPSILON),burst:1},{rate:0.001,burst:10000}])assert.throws(()=>new MemoryTokenBuckets().take('x',policy),/invalid/);});

test('If-None-Match uses bounded weak comparison semantics',()=>{const etag='"abc"';for(const value of ['*','W/"abc"','"other", "abc"',' \tW/"abc" \t'])assert.equal(ifNoneMatchMatches(value,etag),true);for(const value of [undefined,'','abc','W/abc','"abc", broken','"other"','x'.repeat(8193),Array(130).fill('"x"').join(',')])assert.equal(ifNoneMatchMatches(value,etag),false);});

test('gateway contract drift is detected before regeneration without touching tracked output',()=>{const scratch=mkdtempSync(resolve(tmpdir(),'weh-contract-drift-')),source=resolve(scratch,'source'),output=resolve(scratch,'output'),real=resolve(import.meta.dirname,'../contracts/v1');try{cpSync(real,source,{recursive:true});cpSync(real,output,{recursive:true});verifyGatewayContractDrift(source,output);writeFileSync(resolve(output,'README.md'),'mutated\n');assert.throws(()=>verifyGatewayContractDrift(source,output),/stale/);}finally{rmSync(scratch,{recursive:true,force:true});}});

test('key CLI secrecy, redaction, and source fixtures contain no raw key',()=>{const k=createKey();assert.match(k.raw,/^weh_live_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);assert.equal(redact(`Authorization: Bearer ${k.raw}`).includes(k.raw),false);const inspect=spawnSync(process.execPath,['src/cli.mjs','inspect'],{cwd:resolve(import.meta.dirname,'..'),encoding:'utf8'});assert.equal(inspect.stdout.includes('weh_'),false);for(const file of ['src/gateway.mjs','fixtures/keys.synthetic.json'])assert.equal(/weh_live_[a-z0-9]{12}_[A-Za-z0-9_-]{43}/.test(readFileSync(resolve(import.meta.dirname,'..',file),'utf8')),false);});

test('invalid startup clocks and CLI configuration fail generically',()=>{const c=config({now:()=>NaN});assert.throws(()=>createGateway(c.value),/invalid gateway configuration/);const serve=spawnSync(process.execPath,['src/cli.mjs','serve'],{cwd:resolve(import.meta.dirname,'..'),encoding:'utf8',env:{...process.env,GATEWAY_CONFIG:'/does/not/exist',GATEWAY_PEPPER:pepper}});assert.equal(serve.status,1);assert.equal(serve.stderr.trim(),'gateway startup failed');assert.equal(serve.stderr.includes(pepper),false);});

test('root replacement and symlinked ancestors fail closed',async()=>{const g=await start();try{const moved=`${g.files.root}-moved`;renameSync(g.files.root,moved);mkdirSync(g.files.root,{recursive:true});assert.equal((await fetch(`${g.base}/managed/v1/manifest`,{headers:auth(g.key.raw)})).status,503);}finally{await g.gateway.close();}const c=config(),parent=resolve(c.files.root,'..'),link=resolve(parent,`weh-parent-link-${Date.now()}`);symlinkSync(parent,link);assert.throws(()=>createGateway({...c.value,artifactRoot:resolve(link,c.files.root.split('/').at(-1))}),/unsafe/i);});

test('429 and 503 quota errors expose only finite integer headers with allowed CORS',async()=>{const origin='https://synthetic.invalid',c=config(),limited={...c.value.keys[0],quota:{rate:0.5,burst:1}},g=await start({keys:[limited]});try{await fetch(`${g.base}/managed/v1/manifest`,{headers:{...auth(c.key.raw),origin}});const r=await fetch(`${g.base}/managed/v1/manifest`,{headers:{...auth(c.key.raw),origin}});assert.equal(r.status,429);assert.equal(r.headers.get('access-control-allow-origin'),origin);for(const name of ['ratelimit-limit','ratelimit-remaining','ratelimit-reset','retry-after'])assert.match(r.headers.get(name),/^\d+$/);}finally{await g.gateway.close();}const bad=await start({quotaStore:{take:()=>({ok:true,limit:Infinity,remaining:0,reset:0})}});try{const r=await fetch(`${bad.base}/managed/v1/manifest`,{headers:{...auth(bad.key.raw),origin}});assert.equal(r.status,503);assert.equal(r.headers.get('access-control-allow-origin'),origin);for(const name of ['ratelimit-limit','ratelimit-remaining','ratelimit-reset'])assert.equal(r.headers.get(name),null);}finally{await bad.gateway.close();}});
