import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as model from '../model.mjs';

const root = resolve(import.meta.dirname, '../contracts/v1');
const catalog = JSON.parse(readFileSync(resolve(root, 'catalog.synthetic.json')));
const vectors = JSON.parse(readFileSync(resolve(root, 'planning-vectors.synthetic.json'))).vectors;
const request = {method:'GET',route_class:'managed_artifact',authenticated:true,authorized:true};
const plan = (authoritative_state, instant = '2026-08-15T00:00:00.000Z', classification = request) => model.planManagedMeteredRequest({authoritative_state,instant:new Date(instant),request:classification});
const mutate = (fn) => { const value = structuredClone(catalog); fn(value); return value; };

test('catalog is exact and preserves approved free/keyless, permission, and non-offer semantics', () => {
  assert.equal(model.validateCatalog(catalog), true);
  const free = catalog.plans[0];
  assert.equal(free.commercial_use_permitted, true); assert.equal(free.payment_method_required, false); assert.equal(free.sla, false);
  assert.equal(catalog.free_static_surfaces.metered, false); assert.equal(catalog.free_static_surfaces.keyless, true); assert.equal(catalog.non_offer, true);
});

test('all unified ordered-planning vectors match runtime', () => {
  for (const vector of vectors) {
    const run = () => model.planManagedMeteredRequest({authoritative_state:vector.authoritative_state,instant:new Date(vector.instant),request:vector.request});
    if (vector.expected_error) assert.throws(run, new RegExp(vector.expected_error), vector.name);
    else assert.deepEqual(run(), vector.expected, vector.name);
  }
});

test('month boundary atomically records unit one and historical-month evaluation cannot persist', () => {
  const old = {generation:7,utc_month:'2026-08',used_units:100000};
  const result = plan(old, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(result.transition, {expected_state:old,next_state:{generation:8,utc_month:'2026-09',used_units:1}});
  assert.equal(result.decision, 'allow');
  assert.notEqual(result.transition.next_state.utc_month, old.utc_month);
  assert.notEqual(result.transition.next_state.used_units, old.used_units);
});

test('same-month allow and 429 are unique full-state transitions', () => {
  assert.deepEqual(plan({generation:4,utc_month:'2026-08',used_units:12}).transition.next_state, {generation:5,utc_month:'2026-08',used_units:13});
  assert.deepEqual(plan({generation:9,utc_month:'2026-08',used_units:100000}), {units:1,decision:'reject_429',transition:{expected_state:{generation:9,utc_month:'2026-08',used_units:100000},next_state:{generation:10,utc_month:'2026-08',used_units:100000}}});
});

test('full expected-state identity represents stale, concurrent, and replay rejection without an apply API', () => {
  const state = {generation:4,utc_month:'2026-08',used_units:12};
  const transition = plan(state).transition;
  const fullStateMatches = (actual) => assert.deepEqual(actual, transition.expected_state, 'full expected state must match authoritative store state');
  fullStateMatches(state);
  for (const stale of [{...state,generation:5},{...state,used_units:13},{...state,utc_month:'2026-09'},transition.next_state]) assert.throws(() => fullStateMatches(stale), /full expected state/);
  assert.equal('applyFullStateCas' in model, false);
});

test('runtime enforces usage cap and generation overflow before deriving mutation', () => {
  for (const used_units of [100001, Number.MAX_SAFE_INTEGER, 0.5, NaN, Infinity, '1']) assert.throws(() => plan({generation:1,utc_month:'2026-08',used_units}), /used_units/);
  assert.throws(() => plan({generation:Number.MAX_SAFE_INTEGER,utc_month:'2026-08',used_units:1}), /generation overflow/);
  assert.throws(() => plan({generation:Number.MAX_SAFE_INTEGER,utc_month:'2026-08',used_units:1}, '2026-09-01T00:00:00.000Z'), /generation overflow/);
});

test('zero-unit classes never transition in the same or a later month', () => {
  const state = {generation:6,utc_month:'2026-08',used_units:100000};
  for (const instant of ['2026-08-31T00:00:00.000Z','2026-09-01T00:00:00.000Z']) {
    for (const classification of [
      {...request,authenticated:false}, {...request,authorized:false}, {...request,method:'OPTIONS'},
      {...request,route_class:'health'}, {...request,route_class:'unknown'}, {...request,route_class:'query_bearing'},
      {method:'GET',route_class:'free_static',authenticated:false,authorized:false},
    ]) assert.deepEqual(plan(state, instant, classification), {units:0,decision:'not_metered',transition:null});
  }
});

test('legacy split/reset/apply APIs and inputs are absent or rejected', () => {
  for (const name of ['evaluateAllowance','resetForUtcMonth','applyFullStateCas']) assert.equal(name in model, false);
  assert.throws(() => model.planManagedMeteredRequest({authoritative_state:{generation:1,utc_month:'2026-08',used_units:0},request}), /managed metering input/);
  assert.throws(() => model.planManagedMeteredRequest({authoritative_state:{generation:1,utc_month:'2026-08',used_units:0},instant:new Date('2026-08-01'),request,next_state:{generation:2,utc_month:'2099-12',used_units:100000}}), /managed metering input/);
});

for (const [name, value] of [
  ['unknown metadata', mutate((x) => { x.tracking = {}; })], ['crisis dimension', mutate((x) => { x.privacy.allowed.push('crisis_intent'); })],
  ['query dimension', mutate((x) => { x.privacy.allowed.push('query'); })], ['invented growth price', mutate((x) => { x.plans[1].base_subscription_usd = 49; })],
  ['automatic conversion', mutate((x) => { x.plans[1].automatic_free_conversion = true; })], ['charging without opt-in', mutate((x) => { x.plans[1].charge_opt_in_required = false; })],
  ['card requirement', mutate((x) => { x.plans[0].payment_method_required = true; })], ['commercial prohibition', mutate((x) => { x.plans[0].commercial_use_permitted = false; })],
  ['SLA claim', mutate((x) => { x.plans[0].sla = true; })], ['metered static API', mutate((x) => { x.free_static_surfaces.metered = true; })],
  ['permission caveat mutation', mutate((x) => { x.plans[0].permission_caveat += ' changed'; })],
]) test(`rejects ${name}`, () => assert.throws(() => model.validateCatalog(value)));
