import * as migration_20260907_125602_initial_accounts_billing from './20260907_125602_initial_accounts_billing';

export const migrations = [
  {
    up: migration_20260907_125602_initial_accounts_billing.up,
    down: migration_20260907_125602_initial_accounts_billing.down,
    name: '20260907_125602_initial_accounts_billing'
  },
];
