#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createKey, verifier } from './security.mjs';
import { createGateway } from './gateway.mjs';
const [command,...args]=process.argv.slice(2);
if(command==='create-key'){
  const test=args.includes('--test-only'); const pepper=process.env.GATEWAY_PEPPER; if(typeof pepper!=='string'||pepper.length<(test?16:32)) throw new Error('GATEWAY_PEPPER is required and too short');
  const entropy=test?((n)=>Buffer.alloc(n,7)):undefined; const key=createKey({entropy,test});
  console.log(JSON.stringify({raw_key:key.raw,record:{id:key.id,verifier:verifier(key.raw,pepper),state:'active',not_before:null,expires_at:null,api_majors:[1],permissions:['manifest','records','resolver'],quota:{rate:1,burst:10},synthetic:test}},null,2));
} else if(command==='serve') {
  try {
    if(typeof process.env.GATEWAY_CONFIG!=='string'||typeof process.env.GATEWAY_PEPPER!=='string')throw new Error();
    const config=JSON.parse(readFileSync(process.env.GATEWAY_CONFIG,'utf8'));config.pepper=process.env.GATEWAY_PEPPER;
    const gateway=createGateway(config);await gateway.listen();console.log(JSON.stringify({event:'gateway_started',address:gateway.server.address().address,port:gateway.server.address().port}));
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{try{await gateway.close();process.exit(0);}catch{process.exit(1);}});
  } catch { console.error('gateway startup failed');process.exitCode=1; }
} else if(command==='inspect') console.log(JSON.stringify({component:'managed-api-gateway',foundation:true}));
else { console.error('usage: cli.mjs create-key|serve|inspect'); process.exitCode=2; }
