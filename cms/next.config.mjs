import { withPayload } from '@payloadcms/next/withPayload';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ['@libsql/client', 'libsql', 'pg'],
};

export default withPayload(nextConfig, { devBundleServerPackages: false });
