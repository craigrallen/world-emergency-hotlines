# World Hotlines CMS (Payload + Next.js) — separate Railway service. Build context is
# `cms/` (set the Railway service root directory to `cms`). Postgres is required in
# production; secrets arrive only as runtime variables, never in the image.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error
COPY . .
# No runtime variables here on purpose: next.config.mjs publishes the build phase and
# src/env.ts substitutes a labelled placeholder secret during `next build` only. The
# runtime stage below starts with nothing but the variables the platform provides and
# refuses to serve without a real PAYLOAD_SECRET and a Postgres DATABASE_URL.
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/cms/api/account/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
