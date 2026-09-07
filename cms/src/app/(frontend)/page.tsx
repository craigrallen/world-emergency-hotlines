import React from 'react';

export const dynamic = 'force-static';

// The CMS is reached through the public site (Caddy proxies /admin, /cms/api, and
// /_next). This root page only exists so a direct hit on the service is explained.
export default function Home() {
  return (
    <>
      <h1 style={{ fontSize: '1.5rem' }}>World Hotlines CMS</h1>
      <p>Accounts, billing, and user administration backend for worldhotlines.org.</p>
      <ul>
        <li><a href="/admin">Admin panel</a> (staff sign-in)</li>
        <li><code>/cms/api/account/status</code> (public service status)</li>
      </ul>
      <p>Crisis information on worldhotlines.org stays free and needs no account.</p>
    </>
  );
}
