# Hotlines.world — build the static site, serve it with Caddy.
# Multi-stage build keeps the final image tiny (~40MB).

# ------- stage 1: build the site -------
FROM python:3.12-alpine AS build
WORKDIR /app

# Only copy what the generator needs
COPY hotlines.json ./
COPY site/ ./site/

RUN python3 site/build.py

# ------- stage 2: serve -------
FROM caddy:2.8-alpine

# Copy the built site into Caddy's webroot
COPY --from=build /app/site/public /srv

# Caddy config — gzip, security headers, SPA-friendly routing
COPY Caddyfile /etc/caddy/Caddyfile

# Railway sets $PORT. Caddy's Caddyfile picks it up via environment substitution.
ENV PORT=8080
EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
