import type { PayloadRequest } from 'payload';
import { getEnv } from '../env';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

function layout(title: string, intro: string, action: string, href: string): string {
  return [
    '<!doctype html><html lang="en"><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111827;background:#f5f7fb;padding:24px">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ced6e4;border-radius:16px;padding:32px">',
    `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>`,
    `<p style="line-height:1.5">${escapeHtml(intro)}</p>`,
    `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:600">${escapeHtml(action)}</a></p>`,
    `<p style="font-size:13px;color:#58637c;line-height:1.5">If the button does not work, copy this link into your browser:<br>${escapeHtml(href)}</p>`,
    '<p style="font-size:13px;color:#58637c;line-height:1.5">If you did not request this, you can ignore this email. Crisis information on worldhotlines.org stays free and needs no account.</p>',
    '</div></body></html>',
  ].join('');
}

// The token rides in the URL fragment, never the query string: a fragment is never sent in the
// request line (so it never reaches Caddy's access log) and is stripped before the Referer header
// on any subsequent same-origin request, unlike a query parameter on the initial page load.
export const verifyEmailSubject = (): string => 'Verify your World Hotlines account';
export const verifyEmailHTML = ({ token }: { req: PayloadRequest; token: string; user: unknown }): string => {
  const href = `${getEnv().siteUrl}/account/verify#token=${encodeURIComponent(token)}`;
  return layout('Verify your email address', 'Confirm the email address for your World Hotlines account to finish signing up.', 'Verify email', href);
};

export const resetPasswordEmailSubject = (): string => 'Reset your World Hotlines password';
export const resetPasswordEmailHTML = (args?: { req?: PayloadRequest; token?: string; user?: unknown }): string => {
  const href = `${getEnv().siteUrl}/account/reset-password#token=${encodeURIComponent(args?.token ?? '')}`;
  return layout('Reset your password', 'A password reset was requested for your World Hotlines account. The link is valid for one hour.', 'Choose a new password', href);
};
