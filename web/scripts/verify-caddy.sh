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

mkdir -p "$fixture/release/v1/changes" "$fixture/feeds" "$fixture/responses"
expected_release="$fixture/release/v1/release.json"
printf '%s\n' '{"schema_version":"1.0","release_id":"sha256:test"}' > "$expected_release"
printf '%s\n' '{"schema_version":"1.0"}' > "$fixture/release/v1/changes.json"
printf '%s\n' '{"schema_version":"1.0"}' > "$fixture/release/v1/changes/latest.json"
printf '%s\n' '{"version":"https://jsonfeed.org/version/1.1"}' > "$fixture/feeds/releases.json"
printf '%s\n' '<rss version="2.0"><channel><title>Releases</title></channel></rss>' > "$fixture/feeds/releases.rss"
printf '%s\n' '<feed xmlns="http://www.w3.org/2005/Atom"><title>Releases</title></feed>' > "$fixture/feeds/releases.atom"
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

echo "Caddy integration OK: exact GET body; GET/HEAD representation headers; empty HEAD/OPTIONS; release-route CORS; exact unknown-path 404"
