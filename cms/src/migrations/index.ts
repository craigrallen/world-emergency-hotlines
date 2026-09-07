import * as migration_20260907_125602_initial_accounts_billing from './20260907_125602_initial_accounts_billing';
import * as migration_20260907_133303_api_keys_livemode from './20260907_133303_api_keys_livemode';
import * as migration_20260907_134045_verification_and_event_families from './20260907_134045_verification_and_event_families';
import * as migration_20260907_140142_stripe_event_claims from './20260907_140142_stripe_event_claims';
import * as migration_20260907_142758_api_keys_subscription from './20260907_142758_api_keys_subscription';
import * as migration_20260907_144321_users_service_scope from './20260907_144321_users_service_scope';
import * as migration_20260907_151210_keys_issued_by_and_unique_prices from './20260907_151210_keys_issued_by_and_unique_prices';

export const migrations = [
  {
    up: migration_20260907_125602_initial_accounts_billing.up,
    down: migration_20260907_125602_initial_accounts_billing.down,
    name: '20260907_125602_initial_accounts_billing',
  },
  {
    up: migration_20260907_133303_api_keys_livemode.up,
    down: migration_20260907_133303_api_keys_livemode.down,
    name: '20260907_133303_api_keys_livemode',
  },
  {
    up: migration_20260907_134045_verification_and_event_families.up,
    down: migration_20260907_134045_verification_and_event_families.down,
    name: '20260907_134045_verification_and_event_families',
  },
  {
    up: migration_20260907_140142_stripe_event_claims.up,
    down: migration_20260907_140142_stripe_event_claims.down,
    name: '20260907_140142_stripe_event_claims',
  },
  {
    up: migration_20260907_142758_api_keys_subscription.up,
    down: migration_20260907_142758_api_keys_subscription.down,
    name: '20260907_142758_api_keys_subscription',
  },
  {
    up: migration_20260907_144321_users_service_scope.up,
    down: migration_20260907_144321_users_service_scope.down,
    name: '20260907_144321_users_service_scope',
  },
  {
    up: migration_20260907_151210_keys_issued_by_and_unique_prices.up,
    down: migration_20260907_151210_keys_issued_by_and_unique_prices.down,
    name: '20260907_151210_keys_issued_by_and_unique_prices'
  },
];
