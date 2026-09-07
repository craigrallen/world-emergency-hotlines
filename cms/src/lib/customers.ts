/**
 * Stripe keeps test-mode and live-mode objects in separate namespaces, so an account
 * holds one customer id per billing mode. A deployment that ran in test mode first and
 * is then promoted to live therefore creates live customers instead of reusing test
 * ids (which the live client would refuse), and the test ids stay where a rollback
 * to test mode finds them.
 */
export type CustomerField = 'stripeLiveCustomerId' | 'stripeTestCustomerId';
export const CUSTOMER_FIELDS: readonly CustomerField[] = Object.freeze(['stripeLiveCustomerId', 'stripeTestCustomerId'] as const);
export const CUSTOMER_ID = /^cus_[A-Za-z0-9]{8,}$/;

/** The users field that holds the customer for a billing mode. */
export const customerField = (livemode: boolean): CustomerField => (livemode ? 'stripeLiveCustomerId' : 'stripeTestCustomerId');

/** The account's Stripe customer in a billing mode, or null. */
export function customerOf(user: Record<string, unknown> | null | undefined, livemode: boolean): string | null {
  const value = user?.[customerField(livemode)];
  return typeof value === 'string' && CUSTOMER_ID.test(value) ? value : null;
}
