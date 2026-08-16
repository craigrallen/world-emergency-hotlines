/** Normalize only a complete, unambiguous phone value for a tel: URI. */
export function normalizePhoneContact(raw: string): string | null {
  const value = String(raw).trim();
  const plain = /^\+?\d+(?:(?: +|-)\d+)*$/;
  // A parenthesized area-code group is formatting only in these two positions:
  // at the start, or after an international/national prefix and a space. It
  // must contain digits and be followed by another digit group.
  const withAreaCode = /^\+?(?:\(\d+\)|\d+ +\(\d+\))(?:(?: +|-)\d+)+$/;
  if (!plain.test(value) && !withAreaCode.test(value)) return null;
  const normalized = value.replace(/[ ()-]/g, '');
  const digits = normalized.startsWith('+') ? normalized.slice(1) : normalized;
  return /^\d{2,15}$/.test(digits) ? normalized : null;
}

/** Keep SMS/text destinations deliberately narrower than phone destinations. */
export function normalizeMessageContact(raw: string): string | null {
  const value = String(raw).trim();
  if (!/^\+?\d+(?:(?: +|-)\d+)*$/.test(value)) return null;
  const normalized = value.replace(/[ -]/g, '');
  const digits = normalized.startsWith('+') ? normalized.slice(1) : normalized;
  return /^\d{3,15}$/.test(digits) ? normalized : null;
}

export interface MessageContact {
  kind: 'SMS' | 'Text' | 'SMS/text';
  value: string;
  uri: string | null;
}

export interface PhoneContact {
  value: string;
  uri: string | null;
}

/** Test absolute HTTP(S) destinations without transforming their canonical bytes. */
export function isSafeHttpUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.trim() !== raw || raw.length === 0) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Accept only a simple mailbox address that is safe to append to a mailto: URI. */
export function isSafeEmailAddress(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 254 || raw.trim() !== raw) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(raw) || raw.includes('..')) return false;
  const match = raw.match(/^([A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9])?)@(.+)$/);
  if (!match || match[1].length > 64) return false;
  const labels = match[2].split('.');
  if (labels.length < 2 || !/^[A-Za-z]{2,63}$/.test(labels.at(-1) ?? '')) return false;
  return labels.every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ));
}

/** Preserve canonical display values while allowing only strict, unambiguous phone destinations. */
export function phoneContacts(voiceNumbers: readonly string[], shortCodes: readonly string[]): PhoneContact[] {
  return [...voiceNumbers, ...shortCodes]
    .map((raw) => String(raw))
    .filter((value) => value.trim().length > 0)
    .map((value) => ({ value, uri: normalizePhoneContact(value) }));
}

/** Build display contacts without changing source arrays, merging repeated destinations in first-seen order. */
export function dedupeMessageContacts(smsNumbers: readonly string[], textNumbers: readonly string[]): MessageContact[] {
  const contacts: Array<MessageContact & { kinds: Set<'SMS' | 'Text'> }> = [];
  const byDestination = new Map<string, MessageContact & { kinds: Set<'SMS' | 'Text'> }>();

  for (const [kind, values] of [['SMS', smsNumbers], ['Text', textNumbers]] as const) {
    for (const raw of values) {
      const value = String(raw).trim();
      if (!value) continue;
      const uri = normalizeMessageContact(value);
      const destination = uri ? `uri:${uri}` : `text:${value}`;
      const existing = byDestination.get(destination);
      if (existing) {
        existing.kinds.add(kind);
        existing.kind = existing.kinds.size === 2 ? 'SMS/text' : kind;
        continue;
      }
      const contact = { kind, value, uri, kinds: new Set<'SMS' | 'Text'>([kind]) };
      contacts.push(contact);
      byDestination.set(destination, contact);
    }
  }

  return contacts.map(({ kind, value, uri }) => ({ kind, value, uri }));
}
