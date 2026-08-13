import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import SwaggerParser from '@apidevtools/swagger-parser';
import { evaluateConfigActivation, invariant, ROLE_PERMISSIONS } from '../../control-plane/model.mjs';
import { FILES, generateOrganizationContractsForTest, verifyOrganizationContractDrift } from './generate-organization-contracts.mjs';

const WEB=resolve(fileURLToPath(new URL('..',import.meta.url))),SOURCE=resolve(WEB,'../control-plane/v1'),PUBLIC=resolve(WEB,'public/organizations/v1');
const json=(name,root=PUBLIC)=>JSON.parse(readFileSync(resolve(root,name),'utf8')),clone=structuredClone;
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v),digest=content=>`sha256:${createHash('sha256').update(canonical(content)).digest('hex')}`;
const schema=json('model.schema.json'),fixture=json('fixture.synthetic.json'),ajv=new Ajv2020({allErrors:true,strict:true,strictTypes:false});addFormats(ajv);const validate=ajv.compile(schema);
assert.equal(validate(fixture),true,ajv.errorsText(validate.errors));assert.equal(invariant(fixture),true);verifyOrganizationContractDrift();

function invalid(mutator,label,semantic=true){const value=clone(fixture);mutator(value);if(semantic)assert.throws(()=>invariant(value),undefined,label);else assert.equal(validate(value),false,label);}
function rejected(command,reason,model=fixture){const before=clone(model),output=evaluateConfigActivation(before,command);assert.equal(output.result.outcome,'rejected');assert.equal(output.result.reason_code,reason);assert.equal(output.result.changed,false);assert.deepEqual(output.state,before);assert.deepEqual(before,model);return output;}
const acceptedCommand=fixture.transition_scenarios[0].command;
const boundaryInvalid=(mutator,label)=>{const value=clone(fixture);mutator(value);for(const [name,call] of [['evaluator',()=>evaluateConfigActivation(value,acceptedCommand)],['invariant',()=>invariant(value)]])assert.throws(call,/^Error: invalid control-plane input$/,`${label}: ${name}`);};
for(const [label,mutate] of [
  ['signature status',x=>x.hosted_config_versions[0].signature_metadata.status='signed'],['policy NaN',x=>x.organizations[0].policy_version=NaN],['policy Infinity',x=>x.organizations[0].policy_version=Infinity],['policy bound',x=>x.organizations[0].policy_version=10000],['empty label',x=>x.organizations[0].display_label=''],['bad label',x=>x.projects[0].display_label='Customer'],['contract status',x=>x.contract_status='deployed'],['organization state',x=>x.organizations[0].state='deleted'],['project state',x=>x.projects[0].state='deleted'],['role',x=>x.role_assignments[0].role='superuser'],['assignment permission',x=>x.role_assignments[0].permissions=['root']],['assignment state',x=>x.role_assignments[0].state='pending'],['key permission',x=>x.key_references[0].permissions=['root']],['key state',x=>x.key_references[0].state='deleted'],['quota window',x=>x.key_references[0].quota_summary.window='second'],['quota bound',x=>x.key_references[0].quota_summary.request_limit=0],['quota integer',x=>x.key_references[0].quota_summary.request_limit=1.5],['digest shape',x=>x.hosted_config_versions[0].content_digest='sha256:nope'],['presentation theme',x=>x.hosted_config_versions[0].content.presentation.theme='neon'],['presentation density',x=>x.hosted_config_versions[0].content.presentation.density='dense'],['presentation boolean',x=>x.hosted_config_versions[0].content.presentation.show_attribution=1],['presentation bound',x=>x.hosted_config_versions[0].content.presentation.max_results=21],['resolver language',x=>x.hosted_config_versions[0].content.resolver_defaults.language_mode='auto'],['resolver sort',x=>x.hosted_config_versions[0].content.resolver_defaults.sort_mode='random'],['resolver empty',x=>x.hosted_config_versions[0].content.resolver_defaults.empty_state='blank'],['extra top level',x=>x.extra=true],['extra nested',x=>x.projects[0].extra=true],['bad origin',x=>x.projects[0].allowed_origins=['https://live.example.com']],['noncanonical timestamp',x=>x.effective_at='2038-01-19T03:14:07Z'],['impossible timestamp',x=>x.effective_at='2038-02-30T03:14:07.000Z'],['zero scenarios plus invalid field',x=>{x.transition_scenarios=[];x.contract_status='wrong';}],['accepted result branch',x=>x.transition_scenarios[0].result.changed=false],['rejected result branch',x=>x.transition_scenarios[1].result.reason_code='policy_allowed']
])boundaryInvalid(mutate,label);
const exotic=[];
const sparse=clone(fixture);delete sparse.projects[0].allowed_origins[0];exotic.push(['sparse array',sparse]);
const polluted=clone(fixture);Object.setPrototypeOf(polluted.projects[0],{evil:true});exotic.push(['prototype',polluted]);
const getter=clone(fixture);Object.defineProperty(getter.projects[0],'display_label',{enumerable:true,get(){throw new Error('getter ran');}});exotic.push(['getter',getter]);
const cyclic=clone(fixture);cyclic.projects[0].cycle=cyclic;exotic.push(['cycle',cyclic]);
const nonfinite=clone(fixture);nonfinite.projects[0].extra=Infinity;exotic.push(['nonfinite',nonfinite]);
const undefinedValue=clone(fixture);undefinedValue.projects[0].extra=undefined;exotic.push(['undefined',undefinedValue]);
const bigintValue=clone(fixture);bigintValue.projects[0].extra=1n;exotic.push(['bigint',bigintValue]);
const symbolValue=clone(fixture);symbolValue.projects[0].extra=Symbol('x');exotic.push(['symbol value',symbolValue]);
const functionValue=clone(fixture);functionValue.projects[0].extra=()=>{};exotic.push(['function',functionValue]);
const symbolKey=clone(fixture);symbolKey.projects[0][Symbol('x')]=true;exotic.push(['symbol key',symbolKey]);
const hidden=clone(fixture);Object.defineProperty(hidden.projects[0],'hidden',{value:true});exotic.push(['non-enumerable property',hidden]);
for(const [label,value] of exotic)for(const [name,call] of [['evaluator',()=>evaluateConfigActivation(value,acceptedCommand)],['invariant',()=>invariant(value)]])assert.throws(call,/^Error: invalid control-plane input$/,`${label}: ${name}`);

for(const origin of ['http://widget.example.invalid','https://name:pass@widget.example.invalid','https://widget.example.invalid:443','https://widget.example.invalid/','https://widget.example.invalid/path','https://widget.example.invalid?q=1','https://widget.example.invalid#x','https://-widget.example.invalid','https://widget-.example.invalid','https://a..b.example.invalid','https://'+`${'a'.repeat(64)}.example.invalid`,'https://xn--widget.example.invalid','https://localhost.example.invalid','https://127.0.0.1.example.invalid','https://Widget.example.invalid','https://widget.example.invalid.','https://widget%2dalpha.example.invalid'])invalid(x=>{x.projects[0].allowed_origins=[origin]},origin);
for(const mutate of [x=>x.organizations[0].project_ids=[],x=>x.organizations[0].project_ids.push('project_demo_unknown'),x=>x.organizations[0].role_assignment_ids=[],x=>x.projects[0].key_reference_ids.pop(),x=>x.projects[0].hosted_config_version_ids.pop(),x=>x.projects[0].organization_id='org_demo_unknown'])invalid(mutate,'ownership completeness');
invalid(x=>x.hosted_config_versions[1].content.revision=3,'noncontiguous revision');invalid(x=>x.hosted_config_versions[1].content.previous_version_id=null,'broken chain');invalid(x=>x.hosted_config_versions[0].content_digest=`sha256:${'0'.repeat(64)}`,'digest');invalid(x=>x.hosted_config_versions[0].lifecycle.state='active','multiple active');
for(const mutate of [x=>x.transition_scenarios.push(clone(x.transition_scenarios[0])),x=>x.transition_scenarios[1].command.id=x.transition_scenarios[0].command.id,x=>x.transition_scenarios[1].command.request_id=x.transition_scenarios[0].command.request_id,x=>x.transition_scenarios[0].result.command_id='command_demo_orphan',x=>x.transition_scenarios[0].audit_event.request_id='request_demo_wrong',x=>x.transition_scenarios[0].audit_event.config_version_id=null,x=>x.transition_scenarios[0].audit_event.reason_code='authorization_denied',x=>x.transition_scenarios[0].audit_event.timestamp='2038-01-19T03:16:08.000Z'])invalid(mutate,'transition/audit mismatch');
for(const mutate of [x=>x.transition_scenarios[0].result.outcome='rejected',x=>x.transition_scenarios[0].result.changed=false,x=>x.transition_scenarios[0].result.reason_code='authorization_denied',x=>x.transition_scenarios[1].expected_after=x.transition_scenarios[0].expected_after])invalid(mutate,'scenario discrimination',false);

for(const patch of [{expected_active_config_version_id:'config_demo_rev1',reason:'concurrent_state_mismatch'},{organization_id:'org_demo_other',reason:'binding_mismatch'},{project_id:'project_demo_other',reason:'binding_mismatch',nullPointer:true},{actor_principal_id:'principal_demo_other',reason:'authorization_denied'}]){const command={...acceptedCommand,...patch};delete command.reason;delete command.nullPointer;const output=rejected(command,patch.reason);if(patch.nullPointer)assert.equal(output.result.active_config_version_id,null);}
const acceptedBefore=clone(fixture),accepted=evaluateConfigActivation(acceptedBefore,acceptedCommand);assert.equal(accepted.result.outcome,'accepted');assert.deepEqual(acceptedBefore,fixture);

for(const [model,command] of [[null,acceptedCommand],[{},acceptedCommand],[{...fixture,effective_at:'not-a-time'},acceptedCommand],[{...fixture,projects:fixture.projects.map(x=>({...x,extra:true}))},acceptedCommand],[fixture,null],[fixture,{}],[fixture,{...acceptedCommand,timestamp:'not-a-time'}],[fixture,{...acceptedCommand,timestamp:'2038-02-30T03:16:07.000Z'}],[fixture,{...acceptedCommand,extra:true}],[Object.assign(Object.create(null),fixture),acceptedCommand],[fixture,Object.assign(Object.create(null),acceptedCommand)]])assert.throws(()=>evaluateConfigActivation(model,command),/^Error: invalid control-plane input$/);
const getterCommand={...acceptedCommand};Object.defineProperty(getterCommand,'timestamp',{enumerable:true,get(){throw new Error('getter ran');}});assert.throws(()=>evaluateConfigActivation(fixture,getterCommand),/^Error: invalid control-plane input$/);
const nullArray=clone(fixture);Object.setPrototypeOf(nullArray.projects,null);assert.throws(()=>evaluateConfigActivation(nullArray,acceptedCommand),/^Error: invalid control-plane input$/);

const newer=clone(fixture),rev3=clone(newer.hosted_config_versions[1]);newer.transition_scenarios=[];rev3.content.id='config_demo_rev3';rev3.content.revision=3;rev3.content.previous_version_id='config_demo_rev2';rev3.content.created_at='2038-01-19T03:16:00.000Z';rev3.content_digest=digest(rev3.content);rev3.lifecycle={state:'draft',updated_at:'2038-01-19T03:16:00.000Z'};newer.hosted_config_versions.push(rev3);newer.projects[0].hosted_config_version_ids.push('config_demo_rev3');rejected({...acceptedCommand,target_config_version_id:'config_demo_rev3'},'invalid_lifecycle',newer);
const variants=[
  ['draft target',x=>x.hosted_config_versions[0].lifecycle.state='draft'],
  ['equal target',x=>x.transition_scenarios.length=0]
];
for(const [label,mutate] of variants){const model=clone(fixture);mutate(model);const command=label==='equal target'?{...acceptedCommand,target_config_version_id:'config_demo_rev2'}:acceptedCommand;rejected(command,'invalid_lifecycle',model);}
const unrelated=clone(fixture);unrelated.transition_scenarios=[];unrelated.hosted_config_versions[0].content.previous_version_id=null;unrelated.hosted_config_versions[1].content.previous_version_id=null;assert.throws(()=>evaluateConfigActivation(unrelated,acceptedCommand),/^Error: invalid control-plane input$/);
const missingChain=clone(fixture);missingChain.transition_scenarios=[];missingChain.hosted_config_versions[1].content.previous_version_id='config_demo_missing';assert.throws(()=>evaluateConfigActivation(missingChain,acceptedCommand),/^Error: invalid control-plane input$/);
const crossProject=clone(fixture);crossProject.transition_scenarios=[];crossProject.hosted_config_versions[0].content.project_id='project_demo_other';assert.throws(()=>evaluateConfigActivation(crossProject,acceptedCommand),/^Error: invalid control-plane input$/);

invalid(x=>x.role_assignments[0].project_id='project_demo_alpha','owner scope');
const developer=clone(fixture.role_assignments[0]);Object.assign(developer,{id:'assignment_demo_dev1',principal_id:'principal_demo_dev1',role:'developer',project_id:'project_demo_alpha',permissions:ROLE_PERMISSIONS.developer});invalid(x=>{x.role_assignments=[developer];x.organizations[0].role_assignment_ids=[developer.id]},'active owner required');
invalid(x=>{const duplicate=clone(x.role_assignments[0]);duplicate.id='assignment_demo_owner2';x.role_assignments.push(duplicate);x.organizations[0].role_assignment_ids.push(duplicate.id)},'duplicate active role');

for(const [label,mutate] of [
  ['fork',x=>{const fork=clone(x.key_references[1]);fork.id='keyref_demo_fork';x.key_references.push(fork);x.projects[0].key_reference_ids.push(fork.id)}],
  ['reverse chronology',x=>x.key_references[1].created_at=x.key_references[0].created_at],
  ['permission mismatch',x=>x.key_references[0].permissions=['widget.resolve']],
  ['quota mismatch',x=>x.key_references[0].quota_summary.request_limit=999],
  ['active predecessor',x=>x.key_references[0].state='active'],
  ['wrong revoked time',x=>x.key_references[0].updated_at='2038-01-19T03:13:07.000Z'],
  ['expired after effective',x=>{x.key_references[0].state='expired';x.key_references[0].expires_at='2038-01-20T03:14:07.000Z'}],
  ['self predecessor',x=>x.key_references[1].rotation_predecessor_id='keyref_demo_current']
])invalid(mutate,label);
invalid(x=>{x.projects[0].state='suspended';x.hosted_config_versions[1].lifecycle.state='retired';x.projects[0].active_hosted_config_version_id='config_demo_rev1';x.hosted_config_versions[0].content.project_id='project_demo_other'},'cross-project suspended pointer');

const api=await SwaggerParser.validate(resolve(PUBLIC,'openapi.json'));assert.equal(api.info['x-world-hotlines-status'],'foundation-design-contract-not-deployed');assert.match(api.servers[0].url,/\.invalid\/future-admin/);const responses=api.paths['/projects/{project_id}/commands/activate-hosted-config'].post.responses;assert.equal(responses['200'].content['application/json'].schema.properties.outcome.const,'accepted');assert.equal(responses['409'].content['application/json'].schema.properties.outcome.const,'rejected');
const sandbox=mkdtempSync(resolve(tmpdir(),'weh-organizations-'));try{const source=resolve(sandbox,'source'),output=resolve(sandbox,'output');mkdirSync(source);for(const name of FILES)cpSync(resolve(SOURCE,name),resolve(source,name));generateOrganizationContractsForTest({source,output,managedRoot:sandbox});assert.deepEqual(readdirSync(output).sort(),[...FILES]);verifyOrganizationContractDrift(source,output,sandbox);rmSync(resolve(output,'README.md'));assert.throws(()=>verifyOrganizationContractDrift(source,output,sandbox),/manifest|stale/);const interrupted=resolve(sandbox,'interrupted');assert.throws(()=>generateOrganizationContractsForTest({source,output:interrupted,managedRoot:sandbox,afterWrite:({index})=>{if(index===1)throw new Error('injected interruption')}}),/injected interruption/);assert.equal(existsSync(interrupted),false);assert.equal(readdirSync(sandbox).some(x=>x.startsWith('interrupted.tmp-')),false);}finally{rmSync(sandbox,{recursive:true,force:true});}
console.log('Organization contracts OK: closed activation scenarios, scope/rotation invariants, immutable content, and pure fail-closed evaluation');
