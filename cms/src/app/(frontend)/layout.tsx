import React from 'react';

export const metadata = {
  title: 'World Hotlines CMS',
  description: 'Accounts, billing, and user administration backend for worldhotlines.org.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '2rem', color: '#111827', background: '#f5f7fb' }}>
        <main style={{ maxWidth: 640, margin: '0 auto' }}>{children}</main>
      </body>
    </html>
  );
}
