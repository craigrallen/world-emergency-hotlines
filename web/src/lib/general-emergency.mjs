/** Keep general-emergency actions literal and within the strict phone length contract. */
export function generalEmergencyContact(value) {
  return { value, uri: typeof value === 'string' && /^\+?[0-9]{2,15}$/.test(value) ? value : null };
}
