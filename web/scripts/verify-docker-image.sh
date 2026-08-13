#!/bin/sh
set -eu

command -v docker >/dev/null 2>&1 || { echo "Docker is required for the deployment image verifier" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required for the deployment image verifier" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node is required for the deployment image verifier" >&2; exit 1; }

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
revision=${GITHUB_SHA:-local}
image="world-hotlines-ci:$revision"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/weh-docker.XXXXXX")
container=""
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT INT TERM

docker build \
  --label "org.opencontainers.image.revision=$revision" \
  --tag "$image" \
  "$repo_root"

container=$(docker run -d --rm -e PORT=8080 -p 127.0.0.1::8080 "$image")
port=$(docker port "$container" 8080/tcp | sed -n '1s/.*://p')
[ -n "$port" ] || { echo "Docker did not publish the container port" >&2; exit 1; }
base="http://127.0.0.1:$port"

attempt=0
until curl --max-time 2 -fsS "$base/status" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 40 ] || { docker logs "$container"; exit 1; }
  sleep 0.25
done

require_page() {
  path=$1 expected=$2 output=$3
  status=$(curl --max-time 5 -sS -o "$output" -w '%{http_code}' "$base$path")
  [ "$status" = 200 ] || { echo "GET $path returned $status, expected 200" >&2; exit 1; }
  grep -F "$expected" "$output" >/dev/null || { echo "GET $path did not contain expected built content: $expected" >&2; exit 1; }
}

require_page /status 'Static build evidence' "$fixture/status.html"
require_page /release 'Release and integrity' "$fixture/release.html"
changelog_title=$(node -e '
  const changelog = require(process.argv[1]);
  const title = changelog.releases?.[0]?.title;
  if (typeof title !== "string" || title.length === 0) process.exit(1);
  process.stdout.write(title);
' "$repo_root/docs/releases.json")
require_page /releases "$changelog_title" "$fixture/releases.html"
require_page /release/v1/release.json '"release_id"' "$fixture/release.json"
require_page /release/v1/changes.json '"latest"' "$fixture/changes.json"
require_page /release/v1/changes/latest.json '"total_changes"' "$fixture/latest.json"
require_page /feeds/releases.json 'https://jsonfeed.org/version/1.1' "$fixture/feed.json"
require_page /feeds/releases.rss '<rss version="2.0"' "$fixture/feed.rss"
require_page /feeds/releases.atom '<feed xmlns="http://www.w3.org/2005/Atom">' "$fixture/feed.atom"
require_page /gateway/v1/README.md 'Foundation contract—not deployed' "$fixture/gateway-readme.md"
require_page /gateway/v1/openapi.json '0.1.0-foundation' "$fixture/gateway-openapi.json"
node - "$fixture/release.json" <<'NODE'
const { readFileSync } = require('node:fs');

const descriptor = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const identity = /^sha256:[0-9a-f]{64}$/;
const valid = descriptor.schema_version === '1.0'
  && descriptor.canonical_origin === 'https://worldhotlines.org'
  && identity.test(descriptor.dataset_version)
  && identity.test(descriptor.release_id)
  && Number.isInteger(descriptor.artifact_index?.artifact_count)
  && descriptor.artifact_index.artifact_count > 0
  && descriptor.mutable_paths === true;
if (!valid) {
  console.error('Release descriptor failed structural validation');
  process.exit(1);
}
NODE

missing=/release/v1/does-not-exist.json
missing_status=$(curl --max-time 5 -sS -o "$fixture/missing.txt" -w '%{http_code}' "$base$missing")
[ "$missing_status" = 404 ] || { echo "GET $missing returned $missing_status, expected 404" >&2; exit 1; }
[ "$(cat "$fixture/missing.txt")" = 'Not found' ] || { echo "GET $missing did not return the stable 404 body" >&2; exit 1; }

echo "Deployment image OK: Docker build; status/release/changelog pages; release descriptor; unknown release 404"
