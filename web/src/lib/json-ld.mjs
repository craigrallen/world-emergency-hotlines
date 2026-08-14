export function serializeJsonLd(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
