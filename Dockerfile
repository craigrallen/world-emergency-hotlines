# Hotlines.world — build the Astro site, serve it with Caddy.
# Multi-stage build keeps the final image tiny.
#
# Stage 1 generates the JSON data shards from the canonical hotlines.json
# and builds the Astro app. Stage 2 serves the produced dist/ via Caddy.

# ------- stage 1: build the Astro site -------
FROM node:22-alpine AS build
WORKDIR /app

# Bring in just the web/ manifest first so npm install caches well across
# unrelated data changes.
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm install --no-audit --no-fund --loglevel=error

# Copy the canonical data, release changelog source, and the rest of the web source
COPY hotlines.json information.json ./
COPY docs/releases.json docs/dataset-releases.json ./docs/
COPY docs/dataset-release-snapshots/ ./docs/dataset-release-snapshots/
COPY gateway/contracts/ ./gateway/contracts/
COPY control-plane/ ./control-plane/
COPY managed-widget-config/ ./managed-widget-config/
COPY web/ ./web/

# Generate /public/data and build the static Astro site
RUN cd web && npm run build

# ------- stage 2: serve -------
FROM caddy:2.8-alpine

# Astro emits its static output to web/dist/
COPY --from=build /app/web/dist /srv

# Caddy config — gzip, security headers, SPA-friendly routing
COPY Caddyfile /etc/caddy/Caddyfile

# Railway sets $PORT; Caddy picks it up via environment substitution.
ENV PORT=8080
EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
