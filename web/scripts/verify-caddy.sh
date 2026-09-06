#!/bin/sh
set -eu

command -v docker >/dev/null 2>&1 || { echo "Docker is required for the Caddy integration verifier" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required for the Caddy integration verifier" >&2; exit 1; }
command -v gzip >/dev/null 2>&1 || { echo "gzip is required for the Caddy integration verifier" >&2; exit 1; }

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
caddy_image='caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
dockerfile_image=$(sed -n 's/^FROM \(caddy:[^ ]*\)$/\1/p' "$repo_root/Dockerfile")
[ "$dockerfile_image" = "$caddy_image" ] || { echo "Caddy image drift: verifier uses $caddy_image but Dockerfile uses ${dockerfile_image:-<missing>}" >&2; exit 1; }
fixture=$(mktemp -d "${TMPDIR:-/tmp}/weh-caddy.XXXXXX")
container=""
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  rm -rf "$fixture"
}
trap cleanup EXIT INT TERM

mkdir -p "$fixture/api/v1" "$fixture/release/v1/changes" "$fixture/feeds" "$fixture/subscriptions/v1" "$fixture/gateway/v1" "$fixture/organizations/v1" "$fixture/managed-widget-config/v1" "$fixture/technical-health/v1" "$fixture/assurance-packs/v1" "$fixture/provider-claims/v1" "$fixture/reviewer-work-queue/v1" "$fixture/managed-api-plans/v1" "$fixture/deprecation-proposals/v1" "$fixture/evidence-backed-coverage/v1" "$fixture/countries" "$fixture/responses"
printf '%s' '{"api_version":"1.0","cards":{"SE":"EMERGENCY fixture"}}' > "$fixture/api/v1/traveler-cards.json"
gzip -n -9 -c "$fixture/api/v1/traveler-cards.json" > "$fixture/api/v1/traveler-cards.json.gz"
printf '%s\n' '/* service worker fixture */' > "$fixture/service-worker.js"
printf '%s\n' '{"name":"PWA fixture"}' > "$fixture/manifest.webmanifest"
printf '%s\n' '<!doctype html><title>Offline fixture</title>' > "$fixture/offline.html"
printf '%s\n' '<!doctype html><title>Countries</title><h1>Countries</h1>' > "$fixture/countries/index.html"
expected_html_404="$fixture/404.html"
printf '%s\n' '<!doctype html><html><head><title>Page not found</title><meta name="robots" content="noindex,follow"></head><body><main data-custom-404="world-hotlines">Page not found</main></body></html>' > "$expected_html_404"
expected_release="$fixture/release/v1/release.json"
printf '%s\n' '{"schema_version":"1.0","release_id":"sha256:test"}' > "$expected_release"
printf '%s\n' '{"schema_version":"1.0"}' > "$fixture/release/v1/changes.json"
printf '%s\n' '{"schema_version":"1.0"}' > "$fixture/release/v1/changes/latest.json"
printf '%s\n' '{"version":"https://jsonfeed.org/version/1.1"}' > "$fixture/feeds/releases.json"
printf '%s\n' '<rss version="2.0"><channel><title>Releases</title></channel></rss>' > "$fixture/feeds/releases.rss"
printf '%s\n' '<feed xmlns="http://www.w3.org/2005/Atom"><title>Releases</title></feed>' > "$fixture/feeds/releases.atom"
printf '%s\n' '{"$schema":"https://json-schema.org/draft/2020-12/schema"}' > "$fixture/subscriptions/v1/event.schema.json"
printf '%s\n' '{"openapi":"3.1.0"}' > "$fixture/subscriptions/v1/openapi.json"
printf '%s\n' '{"schema_version":"1.0"}' > "$fixture/subscriptions/v1/webhook-contract.json"
printf '%s\n' '# Synthetic subscription contract' '' '[Event schema](event.schema.json)' > "$fixture/subscriptions/v1/README.md"
printf '%s\n' '{"$schema":"https://json-schema.org/draft/2020-12/schema"}' > "$fixture/gateway/v1/error.schema.json"
printf '%s\n' '{"openapi":"3.1.0"}' > "$fixture/gateway/v1/openapi.json"
printf '%s\n' '# Foundation contract—not deployed' > "$fixture/gateway/v1/README.md"
printf '%s\n' '{"$schema":"https://json-schema.org/draft/2020-12/schema"}' > "$fixture/organizations/v1/model.schema.json"
printf '%s\n' '{"openapi":"3.1.0"}' > "$fixture/organizations/v1/openapi.json"
printf '%s\n' '# Organization foundation design contract — not deployed' > "$fixture/organizations/v1/README.md"
printf '%s\n' '{"$schema":"https://json-schema.org/draft/2020-12/schema"}' > "$fixture/managed-widget-config/v1/config.schema.json"
printf '%s\n' '{"openapi":"3.1.0"}' > "$fixture/managed-widget-config/v1/openapi.json"
printf '%s\n' '# Managed widget configuration static design contract only' > "$fixture/managed-widget-config/v1/README.md"
printf '%s\n' '{"$schema":"https://json-schema.org/draft/2020-12/schema"}' > "$fixture/technical-health/v1/dashboard.schema.json"
printf '%s\n' '# Static technical-health contract v1 — SYNTHETIC / NOT A SERVICE' > "$fixture/technical-health/v1/README.md"
printf '%s\n' '{"$schema":"https://json-schema.org/draft/2020-12/schema"}' > "$fixture/assurance-packs/v1/assurance-pack.schema.json"
printf '%s\n' '# Data assurance pack v1 — STATIC/SYNTHETIC CONTRACT, NOT A SERVICE' > "$fixture/assurance-packs/v1/README.md"
printf '%s\n' '{"$schema":"https://json-schema.org/draft/2020-12/schema"}' > "$fixture/provider-claims/v1/claim-envelope.schema.json"
printf '%s\n' '# Provider claim staging and independent review v1 — STATIC/SYNTHETIC CONTRACT, NOT AN INTAKE SERVICE' > "$fixture/provider-claims/v1/README.md"
printf '%s\n' '{"$schema":"https://json-schema.org/draft/2020-12/schema"}' > "$fixture/reviewer-work-queue/v1/queue.schema.json"
printf '%s\n' '# Reviewer work queue v1 — STATIC/SYNTHETIC CONTRACT, NOT A WORKBENCH' > "$fixture/reviewer-work-queue/v1/README.md"
printf '%s\n' '{"$schema":"https://json-schema.org/draft/2020-12/schema"}' > "$fixture/managed-api-plans/v1/plan-catalog.schema.json"
printf '%s\n' '# Managed API plans v1 — PROPOSED STATIC/SYNTHETIC DESIGN, NOT AN OFFER' > "$fixture/managed-api-plans/v1/README.md"
printf '%s\n' '{"$schema":"https://json-schema.org/draft/2020-12/schema"}' > "$fixture/deprecation-proposals/v1/proposal.schema.json"
printf '%s\n' '# Deprecation proposal and audit export v1 — STATIC AND SYNTHETIC' > "$fixture/deprecation-proposals/v1/README.md"
printf '%s\n' '{"$schema":"https://json-schema.org/draft/2020-12/schema"}' > "$fixture/evidence-backed-coverage/v1/assessment.schema.json"
printf '%s\n' '# Evidence-backed coverage assessment v1 — STATIC/SYNTHETIC CONTRACT, NOT A SERVICE' > "$fixture/evidence-backed-coverage/v1/README.md"
expected_missing="$fixture/responses/missing.body"
printf '%s' 'Not found' > "$expected_missing"

docker run --rm -e PORT=8080 -v "$repo_root/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$fixture:/srv:ro" "$caddy_image" caddy validate --config /etc/caddy/Caddyfile
container=$(docker run -d --rm -e PORT=8080 -p 127.0.0.1::8080 -v "$repo_root/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$fixture:/srv:ro" "$caddy_image")
port=$(docker port "$container" 8080/tcp | sed -n 's/.*://p')
base="http://127.0.0.1:$port"

attempt=0
until curl --max-time 2 -fsS "$base/release/v1/release.json" >/dev/null 2>&1; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 40 ] || { docker logs "$container"; exit 1; }
  sleep 0.25
done

response_status() {
  sed -n '1s/.* \([0-9][0-9][0-9]\).*/\1/p' "$1" | tr -d '\r'
}

header_value() {
  name=$1 headers=$2
  sed -n "s/^$name:[[:space:]]*//Ip" "$headers" | tr -d '\r' | tail -n 1
}

require_status() {
  method=$1 path=$2 expected=$3 headers=$4
  actual=$(response_status "$headers")
  [ "$actual" = "$expected" ] || { echo "$method $path returned $actual, expected $expected" >&2; exit 1; }
}

require_header() {
  headers=$1 name=$2 expected=$3
  actual=$(header_value "$name" "$headers")
  [ "$actual" = "$expected" ] || { echo "$name was '$actual', expected '$expected'" >&2; exit 1; }
}

require_no_header() {
  headers=$1 name=$2
  actual=$(header_value "$name" "$headers")
  [ -z "$actual" ] || { echo "$name was '$actual', expected it to be absent" >&2; exit 1; }
}

require_empty() {
  method=$1 path=$2 body=$3
  bytes=$(wc -c < "$body" | tr -d ' ')
  [ "$bytes" = 0 ] || { echo "$method $path returned $bytes response body bytes, expected 0" >&2; exit 1; }
}

card_path=/api/v1/traveler-cards.json
card_headers="$fixture/responses/traveler-cards-get.headers"
card_body="$fixture/responses/traveler-cards-get.body"
curl --max-time 5 -sS -H 'Accept-Encoding: identity' -D "$card_headers" -o "$card_body" "$base$card_path"
require_status GET "$card_path" 200 "$card_headers"
require_header "$card_headers" Content-Type 'application/json'
require_no_header "$card_headers" Content-Encoding
cmp -s "$fixture/api/v1/traveler-cards.json" "$card_body" || { echo "GET $card_path did not return raw JSON bytes" >&2; exit 1; }
card_length=$(wc -c < "$card_body" | tr -d ' ')
require_header "$card_headers" Content-Length "$card_length"
card_head_headers="$fixture/responses/traveler-cards-head.headers"
card_head_body="$fixture/responses/traveler-cards-head.body"
curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Accept-Encoding: identity' -H 'Connection: close' -D "$card_head_headers" -o "$card_head_body" "$base$card_path"
require_status HEAD "$card_path" 200 "$card_head_headers"
require_header "$card_head_headers" Content-Type 'application/json'
require_no_header "$card_head_headers" Content-Encoding
require_header "$card_head_headers" Content-Length "$card_length"
require_empty HEAD "$card_path" "$card_head_body"
gzip_path=/api/v1/traveler-cards.json.gz
gzip_headers="$fixture/responses/traveler-cards-gzip-get.headers"
gzip_body="$fixture/responses/traveler-cards-gzip-get.body"
curl --max-time 5 -sS -H 'Accept-Encoding: identity' -D "$gzip_headers" -o "$gzip_body" "$base$gzip_path"
require_status GET "$gzip_path" 200 "$gzip_headers"
require_header "$gzip_headers" Content-Type 'application/gzip'
require_no_header "$gzip_headers" Content-Encoding
require_header "$gzip_headers" Cache-Control 'public, max-age=300, stale-while-revalidate=86400'
cmp -s "$fixture/api/v1/traveler-cards.json.gz" "$gzip_body" || { echo "GET $gzip_path did not return exact compatibility bytes" >&2; exit 1; }
gzip -dc "$gzip_body" | cmp -s "$fixture/api/v1/traveler-cards.json" - || { echo "GET $gzip_path did not decompress to raw JSON bytes" >&2; exit 1; }
gzip_length=$(wc -c < "$gzip_body" | tr -d ' ')
gzip_head_headers="$fixture/responses/traveler-cards-gzip-head.headers"
gzip_head_body="$fixture/responses/traveler-cards-gzip-head.body"
curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Accept-Encoding: identity' -H 'Connection: close' -D "$gzip_head_headers" -o "$gzip_head_body" "$base$gzip_path"
require_status HEAD "$gzip_path" 200 "$gzip_head_headers"
require_header "$gzip_head_headers" Content-Type 'application/gzip'
require_no_header "$gzip_head_headers" Content-Encoding
require_header "$gzip_head_headers" Content-Length "$gzip_length"
require_header "$gzip_head_headers" Cache-Control 'public, max-age=300, stale-while-revalidate=86400'
require_empty HEAD "$gzip_path" "$gzip_head_body"
for spec in 'POST|traveler-cards.json' 'GET|missing.json'; do
  method=${spec%%|*}; path=${spec#*|}
  status=$(curl --max-time 5 -sS -X "$method" -o /dev/null -w '%{http_code}' "$base/api/v1/$path")
  [ "$status" = 404 ] || { echo "$method /api/v1/$path returned $status, expected 404" >&2; exit 1; }
done

for spec in 'GET|service-worker.js|no-cache|text/javascript; charset=utf-8' 'HEAD|service-worker.js|no-cache|text/javascript; charset=utf-8' 'GET|manifest.webmanifest|-|application/manifest+json; charset=utf-8' 'HEAD|manifest.webmanifest|-|application/manifest+json; charset=utf-8'; do
  method=${spec%%|*}; rest=${spec#*|}; path=${rest%%|*}; rest=${rest#*|}; expected_cache=${rest%%|*}; expected_type=${rest#*|}
  headers="$fixture/responses/pwa-$method-$path.headers"; body="$fixture/responses/pwa-$method-$path.body"
  if [ "$method" = HEAD ]; then
    curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$headers" -o "$body" "$base/$path"
    require_empty HEAD "/$path" "$body"
  else
    curl --max-time 5 -sS -D "$headers" -o "$body" "$base/$path"
  fi
  require_status "$method" "/$path" 200 "$headers"
  if [ "$expected_cache" = - ]; then require_no_header "$headers" Cache-Control; else require_header "$headers" Cache-Control "$expected_cache"; fi
  require_header "$headers" Content-Type "$expected_type"
done

require_release_headers() {
  headers=$1
  require_header "$headers" Access-Control-Allow-Origin '*'
  require_header "$headers" Access-Control-Allow-Methods 'GET, HEAD, OPTIONS'
  require_header "$headers" Access-Control-Allow-Headers 'Accept, If-None-Match, If-Modified-Since'
  require_header "$headers" Cache-Control 'public, max-age=60, stale-while-revalidate=300'
  require_header "$headers" Content-Type 'application/json; charset=utf-8'
}

require_missing_headers() {
  headers=$1
  require_header "$headers" Access-Control-Allow-Origin '*'
  require_header "$headers" Access-Control-Allow-Methods 'GET, HEAD, OPTIONS'
  require_header "$headers" Access-Control-Allow-Headers 'Accept, If-None-Match, If-Modified-Since'
  require_header "$headers" Cache-Control 'no-store'
  require_header "$headers" Content-Type 'text/plain; charset=utf-8'
  require_header "$headers" X-Content-Type-Options 'nosniff'
}

require_feed_cors() {
  headers=$1
  require_header "$headers" Access-Control-Allow-Origin '*'
  require_header "$headers" Access-Control-Allow-Methods 'GET, HEAD, OPTIONS'
  require_header "$headers" Access-Control-Allow-Headers 'Accept, If-None-Match, If-Modified-Since'
}

release_path=/release/v1/release.json
get_headers="$fixture/responses/get.headers"
get_body="$fixture/responses/get.body"
curl --max-time 5 -sS -D "$get_headers" -o "$get_body" "$base$release_path"
require_status GET "$release_path" 200 "$get_headers"
require_release_headers "$get_headers"
cmp -s "$expected_release" "$get_body" || { echo "GET $release_path body does not byte-match the fixture" >&2; exit 1; }
expected_length=$(wc -c < "$expected_release" | tr -d ' ')
require_header "$get_headers" Content-Length "$expected_length"

for feed_spec in 'release/v1/changes.json|application/json; charset=utf-8' 'release/v1/changes/latest.json|application/json; charset=utf-8' 'feeds/releases.json|application/feed+json; charset=utf-8' 'feeds/releases.rss|application/rss+xml; charset=utf-8' 'feeds/releases.atom|application/atom+xml; charset=utf-8'; do
  feed_path=${feed_spec%%|*}
  feed_type=${feed_spec#*|}
  feed_headers="$fixture/responses/$(printf '%s' "$feed_path" | tr '/' '-').headers"
  curl --max-time 5 -sS -D "$feed_headers" -o /dev/null "$base/$feed_path"
  require_status GET "/$feed_path" 200 "$feed_headers"
  require_header "$feed_headers" Content-Type "$feed_type"
  require_feed_cors "$feed_headers"
done

for contract_spec in 'subscriptions/v1/event.schema.json|application/schema+json; charset=utf-8' 'subscriptions/v1/openapi.json|application/vnd.oai.openapi+json; charset=utf-8' 'subscriptions/v1/webhook-contract.json|application/json' 'subscriptions/v1/README.md|text/markdown; charset=utf-8'; do
  contract_path=${contract_spec%%|*}
  contract_type=${contract_spec#*|}
  contract_headers="$fixture/responses/$(printf '%s' "$contract_path" | tr '/' '-').headers"
  curl --max-time 5 -sS -D "$contract_headers" -o /dev/null "$base/$contract_path"
  require_status GET "/$contract_path" 200 "$contract_headers"
  require_header "$contract_headers" Content-Type "$contract_type"
  require_feed_cors "$contract_headers"
done

for gateway_spec in 'gateway/v1/error.schema.json|application/schema+json; charset=utf-8' 'gateway/v1/openapi.json|application/vnd.oai.openapi+json; charset=utf-8' 'gateway/v1/README.md|text/markdown; charset=utf-8'; do
  gateway_path=${gateway_spec%%|*}; gateway_type=${gateway_spec#*|}; gateway_headers="$fixture/responses/$(printf '%s' "$gateway_path" | tr '/' '-').headers"
  curl --max-time 5 -sS -D "$gateway_headers" -o /dev/null "$base/$gateway_path"
  require_status GET "/$gateway_path" 200 "$gateway_headers"; require_header "$gateway_headers" Content-Type "$gateway_type"; require_feed_cors "$gateway_headers"
done
for method in POST PUT DELETE; do
  status=$(curl --max-time 5 -sS -X "$method" -o /dev/null -w '%{http_code}' "$base/gateway/v1/openapi.json")
  [ "$status" = 404 ] || { echo "$method static gateway contract returned $status" >&2; exit 1; }
done

for organization_spec in 'organizations/v1/model.schema.json|application/schema+json; charset=utf-8' 'organizations/v1/openapi.json|application/vnd.oai.openapi+json; charset=utf-8' 'organizations/v1/README.md|text/markdown; charset=utf-8'; do
  organization_path=${organization_spec%%|*}; organization_type=${organization_spec#*|}; organization_headers="$fixture/responses/$(printf '%s' "$organization_path" | tr '/' '-').headers"
  curl --max-time 5 -sS -D "$organization_headers" -o /dev/null "$base/$organization_path"
  require_status GET "/$organization_path" 200 "$organization_headers"; require_header "$organization_headers" Content-Type "$organization_type"; require_feed_cors "$organization_headers"
done
for method in POST PUT PATCH DELETE; do
  status=$(curl --max-time 5 -sS -X "$method" -o /dev/null -w '%{http_code}' "$base/organizations/v1/openapi.json")
  [ "$status" = 404 ] || { echo "$method static organization contract returned $status" >&2; exit 1; }
done
for health_spec in 'technical-health/v1/dashboard.schema.json|application/schema+json; charset=utf-8' 'technical-health/v1/README.md|text/markdown; charset=utf-8'; do
  health_path=${health_spec%%|*}; health_type=${health_spec#*|}; health_headers="$fixture/responses/$(printf '%s' "$health_path" | tr '/' '-').headers"
  curl --max-time 5 -sS -D "$health_headers" -o /dev/null "$base/$health_path"
  require_status GET "/$health_path" 200 "$health_headers"; require_header "$health_headers" Content-Type "$health_type"; require_feed_cors "$health_headers"
done
for method in POST PUT PATCH DELETE; do
  status=$(curl --max-time 5 -sS -X "$method" -o /dev/null -w '%{http_code}' "$base/technical-health/v1/dashboard.schema.json")
  [ "$status" = 404 ] || { echo "$method static technical-health contract returned $status" >&2; exit 1; }
done
for spec in 'OPTIONS|technical-health/v1/dashboard.schema.json|204' 'GET|technical-health/v1/missing.json|404' 'HEAD|technical-health/v1/missing.json|404' 'OPTIONS|technical-health/v1/missing.json|404'; do
  method=${spec%%|*}; rest=${spec#*|}; path=${rest%%|*}; expected=${rest#*|}; headers="$fixture/responses/health-$method-$(printf '%s' "$path" | tr '/' '-').headers"
  if [ "$method" = HEAD ]; then curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$headers" -o /dev/null "$base/$path"; else curl --max-time 5 -sS -X "$method" -D "$headers" -o /dev/null "$base/$path"; fi
  require_status "$method" "/$path" "$expected" "$headers"
done
for assurance_spec in 'assurance-packs/v1/assurance-pack.schema.json|application/schema+json; charset=utf-8' 'assurance-packs/v1/README.md|text/markdown; charset=utf-8'; do
  assurance_path=${assurance_spec%%|*}; assurance_type=${assurance_spec#*|}; assurance_headers="$fixture/responses/$(printf '%s' "$assurance_path" | tr '/' '-').headers"
  curl --max-time 5 -sS -D "$assurance_headers" -o /dev/null "$base/$assurance_path"
  require_status GET "/$assurance_path" 200 "$assurance_headers"; require_header "$assurance_headers" Content-Type "$assurance_type"; require_feed_cors "$assurance_headers"
done
for method in POST PUT PATCH DELETE; do
  status=$(curl --max-time 5 -sS -X "$method" -o /dev/null -w '%{http_code}' "$base/assurance-packs/v1/assurance-pack.schema.json")
  [ "$status" = 404 ] || { echo "$method static assurance pack returned $status" >&2; exit 1; }
done
for spec in 'OPTIONS|assurance-packs/v1/assurance-pack.schema.json|204' 'GET|assurance-packs/v1/missing.json|404' 'HEAD|assurance-packs/v1/missing.json|404' 'OPTIONS|assurance-packs/v1/missing.json|404'; do
  method=${spec%%|*}; rest=${spec#*|}; path=${rest%%|*}; expected=${rest#*|}; headers="$fixture/responses/assurance-$method-$(printf '%s' "$path" | tr '/' '-').headers"
  if [ "$method" = HEAD ]; then curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$headers" -o /dev/null "$base/$path"; else curl --max-time 5 -sS -X "$method" -D "$headers" -o /dev/null "$base/$path"; fi
  require_status "$method" "/$path" "$expected" "$headers"
done
for claim_spec in 'provider-claims/v1/claim-envelope.schema.json|application/schema+json; charset=utf-8' 'provider-claims/v1/README.md|text/markdown; charset=utf-8'; do
  claim_path=${claim_spec%%|*}; claim_type=${claim_spec#*|}; claim_headers="$fixture/responses/$(printf '%s' "$claim_path" | tr '/' '-').headers"
  curl --max-time 5 -sS -D "$claim_headers" -o /dev/null "$base/$claim_path"
  require_status GET "/$claim_path" 200 "$claim_headers"; require_header "$claim_headers" Content-Type "$claim_type"; require_feed_cors "$claim_headers"
done
for method in POST PUT PATCH DELETE; do
  status=$(curl --max-time 5 -sS -X "$method" -o /dev/null -w '%{http_code}' "$base/provider-claims/v1/claim-envelope.schema.json")
  [ "$status" = 404 ] || { echo "$method static provider claim contract returned $status" >&2; exit 1; }
done
for spec in 'OPTIONS|provider-claims/v1/claim-envelope.schema.json|204' 'GET|provider-claims/v1/missing.json|404' 'HEAD|provider-claims/v1/missing.json|404' 'OPTIONS|provider-claims/v1/missing.json|404'; do
  method=${spec%%|*}; rest=${spec#*|}; path=${rest%%|*}; expected=${rest#*|}; headers="$fixture/responses/provider-claim-$method-$(printf '%s' "$path" | tr '/' '-').headers"
  if [ "$method" = HEAD ]; then curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$headers" -o /dev/null "$base/$path"; else curl --max-time 5 -sS -X "$method" -D "$headers" -o /dev/null "$base/$path"; fi
  require_status "$method" "/$path" "$expected" "$headers"
done
for plan_spec in 'managed-api-plans/v1/plan-catalog.schema.json|application/schema+json; charset=utf-8' 'managed-api-plans/v1/README.md|text/markdown; charset=utf-8'; do
  path=${plan_spec%%|*}; expected=${plan_spec#*|}
  actual=$(curl --max-time 5 -sS -I "$base/$path" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Tt]ype: //p')
  [ "$actual" = "$expected" ] || { echo "$path MIME: expected $expected, got $actual" >&2; exit 1; }
done
for spec in 'OPTIONS|managed-api-plans/v1/plan-catalog.schema.json|204' 'GET|managed-api-plans/v1/missing.json|404' 'HEAD|managed-api-plans/v1/missing.json|404' 'POST|managed-api-plans/v1/catalog.synthetic.json|404'; do
  method=${spec%%|*}; rest=${spec#*|}; path=${rest%%|*}; expected=${rest##*|}
  if [ "$method" = HEAD ]; then
    status=$(curl --max-time 5 -sS -I -o /dev/null -w '%{http_code}' "$base/$path")
  else
    status=$(curl --max-time 5 -sS -X "$method" -o /dev/null -w '%{http_code}' "$base/$path")
  fi
  [ "$status" = "$expected" ] || { echo "$method $path: expected $expected, got $status" >&2; exit 1; }
done

for proposal_spec in 'deprecation-proposals/v1/proposal.schema.json|application/schema+json; charset=utf-8' 'deprecation-proposals/v1/README.md|text/markdown; charset=utf-8'; do
  path=${proposal_spec%%|*}; expected=${proposal_spec#*|}
  actual=$(curl --max-time 5 -sS -I "$base/$path" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Tt]ype: //p')
  [ "$actual" = "$expected" ] || { echo "$path MIME: expected $expected, got $actual" >&2; exit 1; }
done
for spec in 'OPTIONS|deprecation-proposals/v1/proposal.schema.json|204' 'GET|deprecation-proposals/v1/missing.json|404' 'HEAD|deprecation-proposals/v1/missing.json|404' 'POST|deprecation-proposals/v1/audit-export.synthetic.json|404'; do
  method=${spec%%|*}; rest=${spec#*|}; path=${rest%%|*}; expected=${rest##*|}
  if [ "$method" = HEAD ]; then status=$(curl --max-time 5 -sS -I -o /dev/null -w '%{http_code}' "$base/$path"); else status=$(curl --max-time 5 -sS -X "$method" -o /dev/null -w '%{http_code}' "$base/$path"); fi
  [ "$status" = "$expected" ] || { echo "$method $path: expected $expected, got $status" >&2; exit 1; }
done

for queue_spec in 'reviewer-work-queue/v1/queue.schema.json|application/schema+json; charset=utf-8' 'reviewer-work-queue/v1/README.md|text/markdown; charset=utf-8'; do
  queue_path=${queue_spec%%|*}; queue_type=${queue_spec#*|}; queue_headers="$fixture/responses/$(printf '%s' "$queue_path" | tr '/' '-').headers"
  curl --max-time 5 -sS -D "$queue_headers" -o /dev/null "$base/$queue_path"
  require_status GET "/$queue_path" 200 "$queue_headers"; require_header "$queue_headers" Content-Type "$queue_type"; require_feed_cors "$queue_headers"
done
for method in POST PUT PATCH DELETE; do
  status=$(curl --max-time 5 -sS -X "$method" -o /dev/null -w '%{http_code}' "$base/reviewer-work-queue/v1/queue.schema.json")
  [ "$status" = 404 ] || { echo "$method static reviewer work queue returned $status" >&2; exit 1; }
done
for spec in 'OPTIONS|reviewer-work-queue/v1/queue.schema.json|204' 'GET|reviewer-work-queue/v1/missing.json|404' 'HEAD|reviewer-work-queue/v1/missing.json|404' 'OPTIONS|reviewer-work-queue/v1/missing.json|404'; do
  method=${spec%%|*}; rest=${spec#*|}; path=${rest%%|*}; expected=${rest#*|}; headers="$fixture/responses/reviewer-queue-$method-$(printf '%s' "$path" | tr '/' '-').headers"
  if [ "$method" = HEAD ]; then curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$headers" -o /dev/null "$base/$path"; else curl --max-time 5 -sS -X "$method" -D "$headers" -o /dev/null "$base/$path"; fi
  require_status "$method" "/$path" "$expected" "$headers"
done
for config_spec in 'managed-widget-config/v1/config.schema.json|application/schema+json; charset=utf-8' 'managed-widget-config/v1/openapi.json|application/vnd.oai.openapi+json; charset=utf-8' 'managed-widget-config/v1/README.md|text/markdown; charset=utf-8'; do
  config_path=${config_spec%%|*}; config_type=${config_spec#*|}; config_headers="$fixture/responses/$(printf '%s' "$config_path" | tr '/' '-').headers"
  curl --max-time 5 -sS -D "$config_headers" -o /dev/null "$base/$config_path"
  require_status GET "/$config_path" 200 "$config_headers"; require_header "$config_headers" Content-Type "$config_type"; require_feed_cors "$config_headers"
done
for method in POST PUT PATCH DELETE; do
  status=$(curl --max-time 5 -sS -X "$method" -o /dev/null -w '%{http_code}' "$base/managed-widget-config/v1/openapi.json")
  [ "$status" = 404 ] || { echo "$method static managed widget config returned $status" >&2; exit 1; }
done
for spec in 'OPTIONS|managed-widget-config/v1/openapi.json|204' 'GET|managed-widget-config/v1/missing.json|404' 'HEAD|managed-widget-config/v1/missing.json|404' 'OPTIONS|managed-widget-config/v1/missing.json|404'; do
  method=${spec%%|*}; rest=${spec#*|}; path=${rest%%|*}; expected=${rest#*|}; headers="$fixture/responses/config-$method-$(printf '%s' "$path" | tr '/' '-').headers"
  if [ "$method" = HEAD ]; then curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$headers" -o /dev/null "$base/$path"; else curl --max-time 5 -sS -X "$method" -D "$headers" -o /dev/null "$base/$path"; fi
  require_status "$method" "/$path" "$expected" "$headers"
done
for spec in 'OPTIONS|organizations/v1/openapi.json|204' 'GET|organizations/v1/missing.json|404' 'HEAD|organizations/v1/missing.json|404' 'OPTIONS|organizations/v1/missing.json|404'; do
  method=${spec%%|*}; rest=${spec#*|}; path=${rest%%|*}; expected=${rest#*|}; headers="$fixture/responses/organization-$method-$(printf '%s' "$path" | tr '/' '-').headers"
  if [ "$method" = HEAD ]; then
    curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$headers" -o /dev/null "$base/$path"
  else
    curl --max-time 5 -sS -X "$method" -D "$headers" -o /dev/null "$base/$path"
  fi
  require_status "$method" "/$path" "$expected" "$headers"
done

# Payments foundation: without PAYMENTS_UPSTREAM every /billing/api/* request
# fails closed with the exact service-shaped 503 and is never served from disk.
expected_payments_disabled="$fixture/responses/payments-disabled.expected"
printf '%s' '{"error":{"code":"payments_disabled","message":"Payments are not enabled"}}' > "$expected_payments_disabled"
for spec in 'POST|billing/api/checkout-session' 'POST|billing/api/portal-session' 'POST|billing/api/webhook' 'GET|billing/api/health' 'GET|billing/api/checkout-session' 'PUT|billing/api/webhook' 'GET|billing/api//health' 'GET|BILLING/api/health' 'GET|billing/api/health/' 'GET|billing/api/health?probe=1'; do
  method=${spec%%|*}; path=${spec#*|}
  label=$(printf '%s' "$method-$path" | tr '/?.' '---')
  payments_headers="$fixture/responses/payments-$label.headers"; payments_body="$fixture/responses/payments-$label.body"
  curl --max-time 5 -sS --path-as-is -X "$method" -H 'Origin: https://worldhotlines.org' -D "$payments_headers" -o "$payments_body" "$base/$path"
  require_status "$method" "/$path" 503 "$payments_headers"
  require_header "$payments_headers" Cache-Control 'no-store'
  require_header "$payments_headers" Content-Type 'application/json; charset=utf-8'
  require_header "$payments_headers" X-Content-Type-Options 'nosniff'
  cmp -s "$expected_payments_disabled" "$payments_body" || { echo "$method /$path did not return the exact payments_disabled body" >&2; exit 1; }
done
traversal_status=$(curl --max-time 5 -sS --path-as-is -o /dev/null -w '%{http_code}' "$base/billing/api/../index.html")
[ "$traversal_status" = 404 ] || { echo "dot-segment traversal under /billing/api returned $traversal_status, expected 404 (never a served file, never the proxy)" >&2; exit 1; }
payments_head_headers="$fixture/responses/payments-head.headers"; payments_head_body="$fixture/responses/payments-head.body"
curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$payments_head_headers" -o "$payments_head_body" "$base/billing/api/health"
require_status HEAD /billing/api/health 503 "$payments_head_headers"
require_empty HEAD /billing/api/health "$payments_head_body"
csp_headers="$fixture/responses/csp.headers"
curl --max-time 5 -sS -D "$csp_headers" -o /dev/null "$base/"
csp_value=$(header_value Content-Security-Policy "$csp_headers")
case "$csp_value" in
  *"form-action 'self' https://checkout.stripe.com https://billing.stripe.com"*) ;;
  *) echo "CSP form-action does not allow exactly the Stripe hosted origins: $csp_value" >&2; exit 1 ;;
esac
case "$csp_value" in
  *"script-src"*"stripe"*"style-src"*) echo "CSP script-src must not admit Stripe scripts: $csp_value" >&2; exit 1 ;;
esac
permissions_value=$(header_value Permissions-Policy "$csp_headers")
case "$permissions_value" in
  *"payment=()"*) ;;
  *) echo "Permissions-Policy must keep payment=(): $permissions_value" >&2; exit 1 ;;
esac

readme_body="$fixture/responses/readme.body"
curl --max-time 5 -sS -o "$readme_body" "$base/subscriptions/v1/README.md"
cmp -s "$fixture/subscriptions/v1/README.md" "$readme_body" || { echo "README link target was not served byte-for-byte" >&2; exit 1; }
curl --max-time 5 -fsS "$base/subscriptions/v1/event.schema.json" >/dev/null

contract_head_headers="$fixture/responses/contract-head.headers"
contract_head_body="$fixture/responses/contract-head.body"
curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$contract_head_headers" -o "$contract_head_body" "$base/subscriptions/v1/event.schema.json"
require_status HEAD /subscriptions/v1/event.schema.json 200 "$contract_head_headers"
require_empty HEAD /subscriptions/v1/event.schema.json "$contract_head_body"
require_header "$contract_head_headers" Content-Type 'application/schema+json; charset=utf-8'

readme_head_headers="$fixture/responses/readme-head.headers"
readme_head_body="$fixture/responses/readme-head.body"
curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$readme_head_headers" -o "$readme_head_body" "$base/subscriptions/v1/README.md"
require_status HEAD /subscriptions/v1/README.md 200 "$readme_head_headers"
require_empty HEAD /subscriptions/v1/README.md "$readme_head_body"
require_header "$readme_head_headers" Content-Type 'text/markdown; charset=utf-8'

contract_options_headers="$fixture/responses/contract-options.headers"
contract_options_body="$fixture/responses/contract-options.body"
curl --max-time 5 -sS -X OPTIONS -D "$contract_options_headers" -o "$contract_options_body" "$base/subscriptions/v1/missing.json"
require_status OPTIONS /subscriptions/v1/missing.json 204 "$contract_options_headers"
require_empty OPTIONS /subscriptions/v1/missing.json "$contract_options_body"
require_feed_cors "$contract_options_headers"

for method in GET POST PUT DELETE; do
  contract_missing_headers="$fixture/responses/contract-missing-$method.headers"
  contract_missing_body="$fixture/responses/contract-missing-$method.body"
  curl --max-time 5 -sS -X "$method" -D "$contract_missing_headers" -o "$contract_missing_body" "$base/subscriptions/v1/subscriptions"
  require_status "$method" /subscriptions/v1/subscriptions 404 "$contract_missing_headers"
  cmp -s "$expected_missing" "$contract_missing_body" || { echo "$method subscription design path body is not stable 404" >&2; exit 1; }
done

feed_path=/feeds/releases.json
feed_head_headers="$fixture/responses/feed-head.headers"
feed_head_body="$fixture/responses/feed-head.body"
curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$feed_head_headers" -o "$feed_head_body" "$base$feed_path"
require_status HEAD "$feed_path" 200 "$feed_head_headers"
require_empty HEAD "$feed_path" "$feed_head_body"
require_feed_cors "$feed_head_headers"
require_header "$feed_head_headers" Content-Type 'application/feed+json; charset=utf-8'

for feed_options_path in /feeds/releases.json /feeds/missing.xml; do
  label=$(printf '%s' "$feed_options_path" | tr '/' '-')
  feed_options_headers="$fixture/responses/$label-options.headers"
  feed_options_body="$fixture/responses/$label-options.body"
  curl --max-time 5 -sS -X OPTIONS -D "$feed_options_headers" -o "$feed_options_body" "$base$feed_options_path"
  require_status OPTIONS "$feed_options_path" 204 "$feed_options_headers"
  require_empty OPTIONS "$feed_options_path" "$feed_options_body"
  require_feed_cors "$feed_options_headers"
done

for method in GET HEAD; do
  label=$(printf '%s' "$method" | tr '[:upper:]' '[:lower:]')
  unknown_feed_headers="$fixture/responses/feed-missing-$label.headers"
  unknown_feed_body="$fixture/responses/feed-missing-$label.body"
  if [ "$method" = HEAD ]; then
    curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$unknown_feed_headers" -o "$unknown_feed_body" "$base/feeds/missing.xml"
    require_empty HEAD /feeds/missing.xml "$unknown_feed_body"
  else
    curl --max-time 5 -sS -D "$unknown_feed_headers" -o "$unknown_feed_body" "$base/feeds/missing.xml"
    cmp -s "$expected_missing" "$unknown_feed_body" || { echo "GET unknown feed body is not the stable 404" >&2; exit 1; }
  fi
  require_status "$method" /feeds/missing.xml 404 "$unknown_feed_headers"
  require_feed_cors "$unknown_feed_headers"
done

head_headers="$fixture/responses/head.headers"
head_body="$fixture/responses/head.body"
# An explicit HEAD plus connection close keeps headers in -D and records only
# wire body bytes in -o; ignoring length avoids waiting for the advertised GET
# representation length, which a conforming HEAD response does not transmit.
curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$head_headers" -o "$head_body" "$base$release_path"
require_status HEAD "$release_path" 200 "$head_headers"
require_empty HEAD "$release_path" "$head_body"
require_release_headers "$head_headers"
require_header "$head_headers" Content-Length "$expected_length"

options_headers="$fixture/responses/options.headers"
options_body="$fixture/responses/options.body"
curl --max-time 5 -sS -X OPTIONS -D "$options_headers" -o "$options_body" "$base$release_path"
require_status OPTIONS "$release_path" 204 "$options_headers"
require_empty OPTIONS "$release_path" "$options_body"
require_header "$options_headers" Access-Control-Allow-Origin '*'
require_header "$options_headers" Access-Control-Allow-Methods 'GET, HEAD, OPTIONS'
require_header "$options_headers" Access-Control-Allow-Headers 'Accept, If-None-Match, If-Modified-Since'

missing_path=/release/v1/missing.json
missing_get_headers="$fixture/responses/missing-get.headers"
missing_get_body="$fixture/responses/missing-get.body"
curl --max-time 5 -sS -D "$missing_get_headers" -o "$missing_get_body" "$base$missing_path"
require_status GET "$missing_path" 404 "$missing_get_headers"
cmp -s "$expected_missing" "$missing_get_body" || { echo "GET $missing_path body does not byte-match the stable 404 body" >&2; exit 1; }
require_missing_headers "$missing_get_headers"
missing_length=$(wc -c < "$expected_missing" | tr -d ' ')
require_header "$missing_get_headers" Content-Length "$missing_length"

missing_head_headers="$fixture/responses/missing-head.headers"
missing_head_body="$fixture/responses/missing-head.body"
curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$missing_head_headers" -o "$missing_head_body" "$base$missing_path"
require_status HEAD "$missing_path" 404 "$missing_head_headers"
require_empty HEAD "$missing_path" "$missing_head_body"
require_missing_headers "$missing_head_headers"
require_header "$missing_head_headers" Content-Length "$missing_length"

missing_options_headers="$fixture/responses/missing-options.headers"
missing_options_body="$fixture/responses/missing-options.body"
curl --max-time 5 -sS -X OPTIONS -D "$missing_options_headers" -o "$missing_options_body" "$base$missing_path"
require_status OPTIONS "$missing_path" 204 "$missing_options_headers"
require_empty OPTIONS "$missing_path" "$missing_options_body"
require_header "$missing_options_headers" Access-Control-Allow-Origin '*'
require_header "$missing_options_headers" Access-Control-Allow-Methods 'GET, HEAD, OPTIONS'
require_header "$missing_options_headers" Access-Control-Allow-Headers 'Accept, If-None-Match, If-Modified-Since'

countries_headers="$fixture/responses/countries.headers"
curl --max-time 5 -sS -D "$countries_headers" -o /dev/null "$base/countries"
require_status GET /countries 200 "$countries_headers"
require_header "$countries_headers" Content-Type 'text/html; charset=utf-8'

unknown_html_path=/ordinary-page-that-does-not-exist
unknown_html_get_headers="$fixture/responses/unknown-html-get.headers"
unknown_html_get_body="$fixture/responses/unknown-html-get.body"
curl --max-time 5 -sS -D "$unknown_html_get_headers" -o "$unknown_html_get_body" "$base$unknown_html_path"
require_status GET "$unknown_html_path" 404 "$unknown_html_get_headers"
cmp -s "$expected_html_404" "$unknown_html_get_body" || { echo "GET $unknown_html_path did not serve the custom 404 document" >&2; exit 1; }
grep -Fq 'data-custom-404="world-hotlines"' "$unknown_html_get_body" || { echo "GET $unknown_html_path is missing the custom 404 marker" >&2; exit 1; }
grep -Eiq '<meta[[:space:]][^>]*name="robots"[^>]*content="noindex,follow"' "$unknown_html_get_body" || { echo "GET $unknown_html_path is missing the noindex robots directive" >&2; exit 1; }
if grep -Eiq '<link[[:space:]][^>]*rel="canonical"' "$unknown_html_get_body"; then echo "GET $unknown_html_path unexpectedly includes a canonical link" >&2; exit 1; fi
if grep -Eiq '<meta[[:space:]][^>]*property="og:url"' "$unknown_html_get_body"; then echo "GET $unknown_html_path unexpectedly includes og:url" >&2; exit 1; fi

unknown_html_head_headers="$fixture/responses/unknown-html-head.headers"
unknown_html_head_body="$fixture/responses/unknown-html-head.body"
curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Connection: close' -D "$unknown_html_head_headers" -o "$unknown_html_head_body" "$base$unknown_html_path"
require_status HEAD "$unknown_html_path" 404 "$unknown_html_head_headers"
require_empty HEAD "$unknown_html_path" "$unknown_html_head_body"

for spec in 'GET|evidence-backed-coverage/v1/assessment.schema.json|200' 'HEAD|evidence-backed-coverage/v1/README.md|200' 'OPTIONS|evidence-backed-coverage/v1/assessment.schema.json|204' 'GET|evidence-backed-coverage/v1/missing.json|404' 'HEAD|evidence-backed-coverage/v1/missing.json|404' 'OPTIONS|evidence-backed-coverage/v1/missing.json|404' 'POST|evidence-backed-coverage/v1/assessment.schema.json|404'; do
  method=${spec%%|*}; rest=${spec#*|}; path=${rest%%|*}; expected=${rest#*|}
  if [ "$method" = HEAD ]; then actual=$(curl --max-time 5 -sS -I -o /dev/null -w '%{http_code}' "$base/$path"); else actual=$(curl --max-time 5 -sS -X "$method" -o /dev/null -w '%{http_code}' "$base/$path"); fi
  [ "$actual" = "$expected" ] || { echo "$method /$path returned $actual, expected $expected" >&2; exit 1; }
done

docker rm -f "$container" >/dev/null 2>&1 || true
container=$(docker run -d --rm -e PORT=8080 -e PAYMENTS_UPSTREAM=127.0.0.1:1 -p 127.0.0.1::8080 -v "$repo_root/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$fixture:/srv:ro" "$caddy_image")
port=$(docker port "$container" 8080/tcp | sed -n 's/.*://p')
base="http://127.0.0.1:$port"
attempt=0
until curl --max-time 2 -fsS "$base/release/v1/release.json" >/dev/null 2>&1; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 40 ] || { docker logs "$container"; exit 1; }
  sleep 0.25
done
proxied_status=$(curl --max-time 5 -sS -X POST -o /dev/null -w '%{http_code}' "$base/billing/api/checkout-session")
[ "$proxied_status" = 502 ] || { echo "with PAYMENTS_UPSTREAM set, /billing/api/checkout-session returned $proxied_status, expected 502 from the proxy path" >&2; exit 1; }
index_status=$(curl --max-time 5 -sS -o /dev/null -w '%{http_code}' "$base/release/v1/release.json")
[ "$index_status" = 200 ] || { echo "static routes must be unaffected by PAYMENTS_UPSTREAM (got $index_status)" >&2; exit 1; }

echo "Caddy integration OK: raw JSON API GET/HEAD MIME and read-only 404 boundaries; PWA policy; HTML discovery and custom 404; release/feed/static contract MIME and CORS; no route shadowing"
