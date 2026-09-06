// Build-time view of the payments foundation for the /billing pages.
//
// PUBLIC_PAYMENTS_MODE is inlined by Astro at build time. It only decides
// whether the checkout buttons are enabled; the server-side service and the
// Caddy route independently fail closed, so a stale or wrong value here can
// never start a payment on its own.
import offersContract from '../../../payments/contracts/v1/offers.json';

export const PAYMENTS_MODES = ['disabled', 'test', 'live'] as const;
export type PaymentsMode = (typeof PAYMENTS_MODES)[number];
export type OfferMode = 'subscription' | 'payment';

export interface Offer {
  id: string;
  plan: string;
  label: string;
  mode: OfferMode;
  description: string;
  requires_explicit_opt_in: boolean;
}

const OFFER_ID = /^[a-z][a-z0-9_]{1,31}$/;
const rawMode = import.meta.env.PUBLIC_PAYMENTS_MODE;

export const PAYMENTS_MODE: PaymentsMode = rawMode === 'test' || rawMode === 'live' ? rawMode : 'disabled';
export const PAYMENTS_ENABLED = PAYMENTS_MODE !== 'disabled';
export const CHECKOUT_ACTION = '/billing/api/checkout-session';
export const PORTAL_ACTION = '/billing/api/portal-session';
export const CHECKOUT_SESSION_PATTERN = '^cs_(test|live)_[A-Za-z0-9]{8,}$';
export const CONTRACT_URL = 'https://github.com/craigrallen/world-emergency-hotlines/blob/main/payments/contracts/v1/README.md';
export const RUNBOOK_URL = 'https://github.com/craigrallen/world-emergency-hotlines/blob/main/docs/PAYMENTS.md';

function validateOffers(contract: typeof offersContract): readonly Offer[] {
  if (contract.schema !== 'payments-offers/v1' || contract.price_publication !== 'not_published' || contract.non_offer !== true) {
    throw new Error('payments/contracts/v1/offers.json has an unexpected shape');
  }
  const seen = new Set<string>();
  for (const offer of contract.offers) {
    if (!OFFER_ID.test(offer.id) || seen.has(offer.id)) throw new Error(`invalid or duplicate offer id in offers.json: ${offer.id}`);
    if (offer.mode !== 'subscription' && offer.mode !== 'payment') throw new Error(`invalid offer mode in offers.json: ${offer.id}`);
    seen.add(offer.id);
  }
  return Object.freeze(contract.offers.map((offer) => Object.freeze({ ...offer }) as Offer));
}

export const OFFERS = validateOffers(offersContract);
export const OFFERS_STATUS: string = offersContract.status;
