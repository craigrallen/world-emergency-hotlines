const ISSUES_URL = 'https://github.com/craigrallen/world-emergency-hotlines/issues/new';

function bounded(value, limit = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
}

export function buildHotlineIssueUrl(hotline, country) {
  const name = bounded(hotline?.name || 'Unknown service', 100);
  const title = `Hotline correction: ${name}`.slice(0, 120);
  const context = [
    '## Listing',
    `- Country: ${bounded(country || 'Not shown')}`,
    `- Service: ${name}`,
    `- Organisation: ${bounded(hotline?.organization || 'Not listed')}`,
    `- Category: ${bounded(hotline?.category || 'Not listed')}`,
    `- Geography: ${bounded(hotline?.geography || country || 'Not listed')}`,
    `- Verification status: ${bounded(hotline?.verification_status || 'Not listed')}`,
    `- Source checked: ${bounded(hotline?.last_verified || 'Not recorded')}`,
    '',
    '## What is wrong?',
    '<!-- Do not include sensitive personal or crisis details. Describe the listing problem only: wrong/disconnected contact, changed hours, closure, service-area error, or another correction. -->',
  ].join('\n');
  return `${ISSUES_URL}?${new URLSearchParams({ title, body: context }).toString()}`;
}
