#!/bin/sh
set -eu

command -v docker >/dev/null 2>&1 || { echo "Docker is required for the Caddy integration verifier" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required for the Caddy integration verifier" >&2; exit 1; }

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
caddy_image='caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
fixture=$(mktemp -d "${TMPDIR:-/tmp}/weh-caddy.XXXXXX")
container=""
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  rm -rf "$fixture"
}
trap cleanup EXIT INT TERM

mkdir -p "$fixture/release/v1/changes" "$fixture/feeds" "$fixture/subscriptions/v1" "$fixture/gateway/v1" "$fixture/organizations/v1" "$fixture/managed-widget-config/v1" "$fixture/technical-health/v1" "$fixture/assurance-packs/v1" "$fixture/provider-claims/v1" "$fixture/responses"
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

echo "Caddy integration OK: release/feed/subscription/organization/technical-health/assurance-pack/provider-claim static MIME and CORS; existing-file OPTIONS, all writes and unknown routes enforce the read-only 404 boundary; no route shadowing"
