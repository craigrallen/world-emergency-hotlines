import assert from 'node:assert/strict';

const ALLOWANCE = 100000;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const PERMISSION_CAVEAT = 'Repository access does not grant reuse rights; no repository license exists and permission must be confirmed.';
const exact = (value, keys, label) => {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype, `${label} must be a plain object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or prohibited fields`);
};

export function validateCatalog(value) {
  exact(value, ['schema','status','currency','free_static_surfaces','plans','counter_transition','privacy','non_offer'], 'catalog');
  assert.equal(value.schema, 'managed-api-plan-catalog/v1'); assert.equal(value.status, 'proposed_design_only'); assert.equal(value.currency, 'USD'); assert.equal(value.non_offer, true);
  exact(value.free_static_surfaces, ['keyless','metered','surfaces'], 'free static surfaces');
  assert.equal(value.free_static_surfaces.keyless, true); assert.equal(value.free_static_surfaces.metered, false);
  assert.deepEqual(value.free_static_surfaces.surfaces, ['site','/api/v1/**','feeds','widget','data']);
  assert.ok(Array.isArray(value.plans) && value.plans.length === 3);
  const [free, growth, enterprise] = value.plans;
  exact(free, ['id','availability','monthly_price_usd','monthly_managed_request_units','payment_method_required','commercial_use_permitted','permission_caveat','allowance_behavior','automatic_overage_charge','support','sla','design_only_limits'], 'developer free');
  assert.deepEqual([free.id,free.availability,free.monthly_price_usd,free.monthly_managed_request_units,free.payment_method_required,free.commercial_use_permitted,free.allowance_behavior,free.automatic_overage_charge,free.support,free.sla], ['developer_free','planned',0,ALLOWANCE,false,true,'hard_stop_429_until_next_utc_month',false,'best_effort_community',false]);
  assert.equal(free.permission_caveat, PERMISSION_CAVEAT); exact(free.design_only_limits, ['organizations','projects','active_keys'], 'design-only limits'); assert.deepEqual(free.design_only_limits, {organizations:1,projects:1,active_keys:2});
  exact(growth, ['id','availability','base_subscription_usd','included_units','overage_rate_usd','metered_overage','charge_opt_in_required','automatic_free_conversion'], 'growth');
  assert.deepEqual(growth, {id:'growth',availability:'planned',base_subscription_usd:'not_published',included_units:'not_published',overage_rate_usd:'not_published',metered_overage:true,charge_opt_in_required:true,automatic_free_conversion:false});
  exact(enterprise, ['id','availability','price','options'], 'enterprise'); assert.deepEqual(enterprise, {id:'enterprise',availability:'planned',price:'not_published',options:['custom_volume','sla','support','procurement','security']});
  exact(value.counter_transition, ['implementation','planning_operation','generation','authoritative_state','authority','atomicity','cas_identity','caller_supplied_state_trusted','caller_supplied_generation_trusted','deployed'], 'counter transition');
  assert.deepEqual(value.counter_transition, {implementation:'future_only',planning_operation:'single_ordered_authoritative',generation:'monotonic_safe_integer',authoritative_state:['generation','utc_month','used_units'],authority:'store_read_only',atomicity:'compare_and_swap_required',cas_identity:'full_expected_state',caller_supplied_state_trusted:false,caller_supplied_generation_trusted:false,deployed:false});
  exact(value.privacy, ['allowed','forbidden'], 'privacy'); assert.deepEqual(value.privacy.allowed, ['account_id','utc_month','aggregate_managed_request_units','monotonic_counter_generation']);
  assert.deepEqual(value.privacy.forbidden, ['url','query','raw_path','country','category','hotline','crisis_intent','user_behavior','ip','referrer','contact_data','authorization','raw_key','distress_analytics']);
  return true;
}

export function utcMonth(instant) {
  assert.ok(instant instanceof Date && !Number.isNaN(instant.valueOf()), 'instant must be a valid Date');
  return instant.toISOString().slice(0, 7);
}

function validateState(state, label) {
  exact(state, ['generation','utc_month','used_units'], label);
  assert.match(state.utc_month, MONTH);
  assert.ok(Number.isSafeInteger(state.used_units) && state.used_units >= 0 && state.used_units <= ALLOWANCE, `used_units must be an integer from 0 through ${ALLOWANCE}`);
  assert.ok(Number.isSafeInteger(state.generation) && state.generation >= 0, 'generation must be a non-negative safe integer');
}

function requestUnits(request) {
  exact(request, ['method','route_class','authenticated','authorized'], 'request');
  const { method, route_class: route, authenticated, authorized } = request;
  assert.ok(['GET','HEAD','OPTIONS','POST'].includes(method));
  assert.ok(['managed_artifact','health','unknown','query_bearing','free_static'].includes(route));
  assert.equal(typeof authenticated, 'boolean'); assert.equal(typeof authorized, 'boolean');
  return (method === 'GET' || method === 'HEAD') && route === 'managed_artifact' && authenticated && authorized ? 1 : 0;
}

export function planManagedMeteredRequest(input) {
  exact(input, ['authoritative_state','instant','request'], 'managed metering input');
  const state = input.authoritative_state;
  validateState(state, 'authoritative store state');
  const month = utcMonth(input.instant);
  const units = requestUnits(input.request);
  if (!units) return {units:0, decision:'not_metered', transition:null};
  assert.ok(month >= state.utc_month, 'instant UTC month must not precede state UTC month');
  assert.ok(state.generation < Number.MAX_SAFE_INTEGER, 'generation overflow');
  const next_state = month > state.utc_month
    ? {generation:state.generation + 1, utc_month:month, used_units:1}
    : {generation:state.generation + 1, utc_month:state.utc_month, used_units:Math.min(state.used_units + 1, ALLOWANCE)};
  return {
    units:1,
    decision:month === state.utc_month && state.used_units === ALLOWANCE ? 'reject_429' : 'allow',
    transition:{expected_state:{...state}, next_state},
  };
}
