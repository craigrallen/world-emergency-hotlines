import * as migration_20260907_125602_initial_accounts_billing from './20260907_125602_initial_accounts_billing';
import * as migration_20260907_133303_api_keys_livemode from './20260907_133303_api_keys_livemode';
import * as migration_20260907_134045_verification_and_event_families from './20260907_134045_verification_and_event_families';

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
    name: '20260907_134045_verification_and_event_families'
  },
];
