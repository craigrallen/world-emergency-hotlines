import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { authenticate } from './security.mjs';
import { MemoryTokenBuckets } from './quota.mjs';
import { ARTIFACT_ROUTES, createArtifactStore } from './artifacts.mjs';
import { exactObject, SHA256_ID, validateKeyRecord, validateOrigin } from './validation.mjs';

export const VERSION='0.1.0-foundation';
const HEALTH='/managed/v1/health', KNOWN=new Set([HEALTH,...Object.keys(ARTIFACT_ROUTES)]);
const ERR={400:['body_not_allowed','Request bodies are not allowed'],401:['unauthorized','Authentication failed'],403:['forbidden','Access denied'],404:['not_found','Not found'],405:['method_not_allowed','Method not allowed'],429:['rate_limited','Rate limit exceeded'],503:['unavailable','Service unavailable']};
const EVENT_KEYS=['timestamp','request_id','route_template','artifact_class','api_major','status_class','status_code','latency_bucket','response_bytes_bucket','auth_outcome','quota_outcome','gateway_version','release_id','dataset_version'];
const CONFIG_KEYS=['host','port','mode','artifactRoot','artifactDescriptor','keys','pepper','releaseId','datasetVersion','origins','sink','sinkError','now','quotaStore','maxConcurrent','maxConnections','requestTimeoutMs','headersTimeoutMs','keepAliveTimeoutMs','maxRequestsPerSocket','shutdownTimeoutMs'];
function bucket(n){ return n<256?'<256':n<1024?'<1KiB':n<16384?'<16KiB':'>=16KiB'; }
function integer(value,min,max){return Number.isInteger(value)&&value>=min&&value<=max;}
function validateConfig(config){
  if(!exactObject(config,CONFIG_KEYS,['artifactRoot','artifactDescriptor','keys','pepper','releaseId','datasetVersion']))throw new Error('invalid gateway configuration');
  const mode=config.mode??'synthetic',host=config.host??'127.0.0.1',port=config.port??0,origins=config.origins??[];
  if(!['synthetic','production'].includes(mode)||typeof host!=='string'||host.length<1||host.length>255||!integer(port,0,65535))throw new Error('invalid gateway configuration');
  if(mode==='synthetic'&&!['127.0.0.1','::1','localhost'].includes(host))throw new Error('invalid gateway configuration');
  if(mode==='production'&&(!Object.hasOwn(config,'host')||['127.0.0.1','::1','localhost'].includes(host)))throw new Error('invalid gateway configuration');
  if(typeof config.pepper!=='string'||config.pepper.length<(mode==='production'?32:16)||config.pepper.length>4096)throw new Error('invalid gateway configuration');
  if(!SHA256_ID.test(config.releaseId)||!SHA256_ID.test(config.datasetVersion)||!Array.isArray(config.keys)||config.keys.length<1||config.keys.length>10000)throw new Error('invalid gateway configuration');
  const ids=new Set();for(const record of config.keys){if(!validateKeyRecord(record,mode)||ids.has(record.id))throw new Error('invalid gateway configuration');ids.add(record.id);}
  if(!Array.isArray(origins)||origins.length>100||new Set(origins).size!==origins.length||!origins.every((o)=>validateOrigin(o,mode)))throw new Error('invalid gateway configuration');
  if(config.sink!==undefined&&typeof config.sink!=='function'||config.sinkError!==undefined&&typeof config.sinkError!=='function'||config.now!==undefined&&typeof config.now!=='function')throw new Error('invalid gateway configuration');
  if(config.quotaStore!==undefined&&(config.quotaStore===null||typeof config.quotaStore!=='object'||typeof config.quotaStore.take!=='function'))throw new Error('invalid gateway configuration');
  for(const [name,min,max,def] of [['maxConcurrent',1,10000,32],['maxConnections',1,100000,128],['requestTimeoutMs',100,120000,5000],['headersTimeoutMs',100,120000,3000],['keepAliveTimeoutMs',100,120000,5000],['maxRequestsPerSocket',1,10000,100],['shutdownTimeoutMs',100,60000,5000]])if(!integer(config[name]??def,min,max))throw new Error('invalid gateway configuration');
  return {mode,host,port,origins};
}
function validStoreResult(q){
  if(!q||typeof q!=='object'||Array.isArray(q)||Object.getPrototypeOf(q)!==Object.prototype||typeof q.ok!=='boolean'||!integer(q.limit,1,10000)||!integer(q.remaining,0,q.limit)||!integer(q.reset,0,86400))return false;
  const expected=q.ok?['ok','limit','remaining','reset']:q.overflow===true?['ok','overflow','retryAfter','limit','remaining','reset']:['ok','retryAfter','limit','remaining','reset'];
  return Object.keys(q).length===expected.length&&expected.every(key=>Object.hasOwn(q,key))&&(q.ok||integer(q.retryAfter,1,86400));
}
function corsFor(origin,origins){return typeof origin==='string'&&origins.includes(origin)?{'access-control-allow-origin':origin,'vary':'Origin'}:{};}
export function ifNoneMatchMatches(value, etag) {
  if(typeof value!=='string'||value.length===0||value.length>8192||typeof etag!=='string')return false;
  const target=/^"([\x21\x23-\x7e\x80-\xff]*)"$/.exec(etag);if(!target)return false;
  let count=0,matched=false;for(const raw of value.split(',')){if(++count>128)return false;const token=raw.trim();if(token==='*'){matched=true;continue;}const match=/^(?:W\/)?"([\x21\x23-\x7e\x80-\xff]*)"$/.exec(token);if(!match)return false;if(match[1]===target[1])matched=true;}return matched;
}
function send(res,method,status,body,id,extra={}) { const bytes=Buffer.from(body); res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-request-id':id,'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'",...extra,'content-length':bytes.length}); res.end(method==='HEAD'?undefined:bytes); return bytes.length; }
function error(res,method,status,id,extra){ const [code,message]=ERR[status]; return send(res,method,status,JSON.stringify({error:{code,message,request_id:id}}),id,extra); }

export function createGateway(config){
  const validated=validateConfig(config),{host,port,origins}=validated;
  const sink=config.sink??(()=>{}),sinkError=config.sinkError??(()=>{}),clock=config.now??(()=>Date.now()),quotaStore=config.quotaStore??new MemoryTokenBuckets();
  let initialNow;try{initialNow=clock();}catch{throw new Error('invalid gateway configuration');}if(!Number.isFinite(initialNow))throw new Error('invalid gateway configuration');
  const maxConcurrent=config.maxConcurrent??32,shutdownTimeoutMs=config.shutdownTimeoutMs??5000;
  const keysById=new Map(config.keys.map((record)=>[record.id,Object.freeze({...record,api_majors:Object.freeze([...record.api_majors]),permissions:Object.freeze([...record.permissions]),quota:Object.freeze({...record.quota})})]));
  const artifacts=createArtifactStore({root:config.artifactRoot,descriptor:config.artifactDescriptor,releaseId:config.releaseId,datasetVersion:config.datasetVersion});
  let active=0,stopping=false,sinkErrors=0;const sockets=new Set();
  const server=http.createServer({requestTimeout:config.requestTimeoutMs??5000,headersTimeout:config.headersTimeoutMs??3000,keepAliveTimeout:config.keepAliveTimeoutMs??5000,maxHeaderSize:16384},(req,res)=>{
    const started=performance.now(),id=randomUUID(),raw=req.url||'',query=raw.indexOf('?'),path=query<0?raw:raw.slice(0,query),known=KNOWN.has(path),cors=known?corsFor(req.headers.origin,origins):{};
    let template=path===HEALTH?'health':ARTIFACT_ROUTES[path]?.class??'unknown',authOutcome='not_required',quotaOutcome='not_checked',bytes=0,status=500;
    res.once('finish',()=>{let stamp;try{const value=clock();stamp=Number.isFinite(value)?new Date(value).toISOString():new Date(0).toISOString();}catch{stamp=new Date(0).toISOString();}const event={timestamp:stamp,request_id:id,route_template:template,artifact_class:template==='health'?'health':ARTIFACT_ROUTES[path]?.class??'none',api_major:1,status_class:`${Math.floor(status/100)}xx`,status_code:status,latency_bucket:performance.now()-started<10?'<10ms':'<100ms',response_bytes_bucket:bucket(bytes),auth_outcome:authOutcome,quota_outcome:quotaOutcome,gateway_version:VERSION,release_id:config.releaseId,dataset_version:config.datasetVersion};try{sink(event);}catch{sinkErrors=Math.min(Number.MAX_SAFE_INTEGER,sinkErrors+1);try{sinkError(sinkErrors);}catch{}}});
    const transfer=req.headers['transfer-encoding'],length=req.headers['content-length'];
    if(transfer!==undefined||length!==undefined&&length!=='0'){status=400;res.setHeader('connection','close');bytes=error(res,req.method,status,id,cors);res.once('finish',()=>req.socket.destroy());return;}
    if(stopping||active>=maxConcurrent){status=503;res.setHeader('connection','close');bytes=error(res,req.method,status,id,cors);res.once('finish',()=>req.socket.destroy());return;}
    active++;let accounted=false;const done=()=>{if(!accounted){accounted=true;active=Math.max(0,active-1);}};req.once('end',done);req.once('aborted',done);req.once('close',done);if(req.complete)queueMicrotask(done);else req.resume();
    if(req.method==='OPTIONS'){
      if(!known||query>=0){status=404;bytes=error(res,req.method,status,id);return;}
      status=204;res.writeHead(204,{'access-control-allow-methods':'GET, HEAD, OPTIONS','access-control-allow-headers':'Authorization, Accept, If-None-Match','x-request-id':id,...cors});res.end();return;
    }
    if(query>=0&&known){status=404;bytes=error(res,req.method,status,id,cors);return;}
    if(!['GET','HEAD'].includes(req.method)){status=known?405:404;bytes=error(res,req.method,status,id,{...cors,...(status===405?{allow:'GET, HEAD, OPTIONS'}:{})});return;}
    if(path===HEALTH){status=200;bytes=send(res,req.method,200,JSON.stringify({component:'managed-api-gateway',gateway_version:VERSION,api_major:1,release_id:config.releaseId,dataset_version:config.datasetVersion,foundation:true}),id,cors);return;}
    const item=ARTIFACT_ROUTES[path];if(!item){status=404;bytes=error(res,req.method,status,id);return;}
    let now;try{now=clock();if(!Number.isFinite(now))throw new Error();}catch{status=503;bytes=error(res,req.method,status,id,cors);return;}
    const auth=authenticate(req.headers.authorization,keysById,config.pepper,validated.mode,now);authOutcome=auth.outcome;if(!auth.ok){status=401;bytes=error(res,req.method,status,id,{...cors,'www-authenticate':'Bearer'});return;}
    if(!auth.record.api_majors.includes(1)||!auth.record.permissions.includes(item.permission)){status=403;bytes=error(res,req.method,status,id,cors);return;}
    let q;try{q=quotaStore.take(auth.record.id,auth.record.quota);if(!validStoreResult(q))throw new Error();}catch{quotaOutcome='store_error';status=503;bytes=error(res,req.method,status,id,cors);return;}
    quotaOutcome=q.ok?'allowed':q.overflow?'store_overflow':'limited';const rateHeaders={'ratelimit-limit':String(q.limit),'ratelimit-remaining':String(q.remaining),'ratelimit-reset':String(q.reset)};
    if(!q.ok){status=q.overflow?503:429;bytes=error(res,req.method,status,id,{...cors,...rateHeaders,...(!q.overflow?{'retry-after':String(q.retryAfter)}:{})});return;}
    let data;try{data=artifacts.read(path);}catch{status=503;bytes=error(res,req.method,status,id,{...cors,...rateHeaders});return;}const etag=`"${createHash('sha256').update(data).digest('hex')}"`;
    if(ifNoneMatchMatches(req.headers['if-none-match'],etag)){status=304;res.writeHead(304,{etag,'cache-control':'public, max-age=300, stale-while-revalidate=86400','x-request-id':id,'x-content-type-options':'nosniff',...rateHeaders,...cors});res.end();return;}
    status=200;bytes=data.length;res.writeHead(200,{'content-type':item.contentType,'content-length':data.length,etag,'cache-control':'public, max-age=300, stale-while-revalidate=86400','x-request-id':id,'x-content-type-options':'nosniff',...rateHeaders,...cors});res.end(req.method==='HEAD'?undefined:data);
  });
  server.maxConnections=config.maxConnections??128;server.maxRequestsPerSocket=config.maxRequestsPerSocket??100;
  server.on('connection',(socket)=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  server.on('clientError',(_e,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
  return {server,get activeRequests(){return active;},get sinkErrors(){return sinkErrors;},listen:()=>new Promise((ok,no)=>{const fail=(error)=>{server.off('listening',ready);no(error);},ready=()=>{server.off('error',fail);ok();};server.once('error',fail).once('listening',ready).listen(port,host);}),close:()=>new Promise((ok,no)=>{stopping=true;const timer=setTimeout(()=>{for(const socket of sockets)socket.destroy();},shutdownTimeoutMs);timer.unref();server.close((error)=>{clearTimeout(timer);error?no(error):ok();});server.closeIdleConnections();})};
}

export { EVENT_KEYS };
