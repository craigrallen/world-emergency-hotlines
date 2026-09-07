import { withPayload } from '@payloadcms/next/withPayload';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ['@libsql/client', 'libsql', 'pg'],
};

/**
 * Next hands the current phase to this callback (its documented configuration
 * mechanism). It is published as NEXT_PHASE for `src/env.ts`, which accepts a
 * placeholder secret and the SQLite default only while the phase is
 * `phase-production-build`: the image build stage (Dockerfile, Railway, Compose)
 * runs with no runtime variables on purpose, and at every other phase a missing
 * PAYLOAD_SECRET or a non-Postgres DATABASE_URL in production stops the process.
 * Next sets the same variable itself during `next build`; publishing it here does
 * not depend on that internal detail.
 */
export default (phase) => {
  process.env.NEXT_PHASE = phase;
  return withPayload(nextConfig, { devBundleServerPackages: false });
};
