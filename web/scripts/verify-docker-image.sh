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

if docker exec "$container" sh -c "find /srv -type f -print | grep -E 'reviews|multilingual-ui|review-pack|security-privacy-evidence|technical-due-diligence|due-diligence-evidence|field-provenance-clearance|clearance-ledger'"; then
  echo 'Internal review or evidence path exists in the final served root' >&2; exit 1
fi
for marker in internal-multilingual-ui-review-pack/v1 pending_not_reviewed static_ui_runtime_dictionaries_only internal-security-privacy-evidence-only/v1 repository_internal_deterministic_regression_evidence internal-technical-due-diligence-evidence-only/v1 repository_internal_deterministic_regression_evidence_index internal-field-provenance-clearance-ledger-only/v1; do
  if docker exec "$container" grep -R -F "$marker" /srv >/dev/null 2>&1; then
    echo "Internal review-pack marker exists in the final served root: $marker" >&2; exit 1
  fi
done
for path in /reviews/multilingual-ui/v1/review-pack.json /multilingual-ui/v1/review-pack.json /review-pack.json /reviews/security-privacy-evidence/v1/inventory.json /security-privacy-evidence/v1/inventory.json /security-privacy-evidence.json /reviews/technical-due-diligence/v1/index.json /technical-due-diligence/v1/index.json /technical-due-diligence.json /due-diligence-evidence.json; do
  status=$(curl --max-time 5 -sS -o /dev/null -w '%{http_code}' "$base$path")
  [ "$status" = 404 ] || { echo "Internal review-pack route $path returned $status, expected 404" >&2; exit 1; }
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
require_page /release/v1/artifacts.json '"artifacts"' "$fixture/artifacts.json"
require_page /api/v1/manifest.json '"traveler_cards"' "$fixture/api-manifest.json"
require_page /release/v1/changes.json '"latest"' "$fixture/changes.json"
require_page /release/v1/changes/latest.json '"total_changes"' "$fixture/latest.json"
require_page /feeds/releases.json 'https://jsonfeed.org/version/1.1' "$fixture/feed.json"
require_page /feeds/releases.rss '<rss version="2.0"' "$fixture/feed.rss"
require_page /feeds/releases.atom '<feed xmlns="http://www.w3.org/2005/Atom">' "$fixture/feed.atom"
require_page /manifest.webmanifest '"/pwa-icon-512.png"' "$fixture/manifest.webmanifest"
require_page /service-worker.js "cache.match('/offline.html')" "$fixture/service-worker.js"
require_page /offline.html 'limited offline shell' "$fixture/offline.html"
card_path=/api/v1/traveler-cards.json
card_headers="$fixture/traveler-cards.headers"
card_body="$fixture/traveler-cards.json"
card_status=$(curl --max-time 5 -sS -H 'Accept-Encoding: identity' -D "$card_headers" -o "$card_body" -w '%{http_code}' "$base$card_path")
[ "$card_status" = 200 ] || { echo "GET $card_path returned $card_status, expected 200" >&2; exit 1; }
card_type=$(tr -d '\r' < "$card_headers" | sed -n 's/^[Cc]ontent-[Tt]ype: //p' | tail -n 1)
[ "$card_type" = 'application/json' ] || { echo "production traveler-card MIME was '$card_type', expected application/json" >&2; exit 1; }
card_encoding=$(tr -d '\r' < "$card_headers" | sed -n 's/^[Cc]ontent-[Ee]ncoding: //p' | tail -n 1)
[ -z "$card_encoding" ] || { echo "production traveler-card response unexpectedly used Content-Encoding: $card_encoding" >&2; exit 1; }
card_length=$(wc -c < "$card_body" | tr -d ' ')
[ "$card_length" -le 1048576 ] || { echo "production traveler-card response was $card_length bytes, exceeding the 1048576-byte ceiling" >&2; exit 1; }
served_length=$(tr -d '\r' < "$card_headers" | sed -n 's/^[Cc]ontent-[Ll]ength: //p' | tail -n 1)
[ "$served_length" = "$card_length" ] || { echo "production traveler-card Content-Length was '$served_length', expected $card_length" >&2; exit 1; }
card_cache=$(tr -d '\r' < "$card_headers" | sed -n 's/^[Cc]ache-[Cc]ontrol: //p' | tail -n 1)
[ "$card_cache" = 'public, max-age=300, stale-while-revalidate=86400' ] || { echo "production traveler-card Cache-Control was '$card_cache'" >&2; exit 1; }
card_head_status=$(curl --max-time 5 -sS --request HEAD --ignore-content-length -H 'Accept-Encoding: identity' -H 'Connection: close' -D "$fixture/traveler-cards-head.headers" -o "$fixture/traveler-cards-head.body" -w '%{http_code}' "$base$card_path")
[ "$card_head_status" = 200 ] || { echo "HEAD $card_path returned $card_head_status, expected 200" >&2; exit 1; }
[ ! -s "$fixture/traveler-cards-head.body" ] || { echo "HEAD $card_path returned a body" >&2; exit 1; }
head_type=$(tr -d '\r' < "$fixture/traveler-cards-head.headers" | sed -n 's/^[Cc]ontent-[Tt]ype: //p' | tail -n 1)
head_length=$(tr -d '\r' < "$fixture/traveler-cards-head.headers" | sed -n 's/^[Cc]ontent-[Ll]ength: //p' | tail -n 1)
head_encoding=$(tr -d '\r' < "$fixture/traveler-cards-head.headers" | sed -n 's/^[Cc]ontent-[Ee]ncoding: //p' | tail -n 1)
head_cache=$(tr -d '\r' < "$fixture/traveler-cards-head.headers" | sed -n 's/^[Cc]ache-[Cc]ontrol: //p' | tail -n 1)
[ "$head_type" = 'application/json' ] && [ "$head_length" = "$card_length" ] && [ -z "$head_encoding" ] && [ "$head_cache" = "$card_cache" ] || { echo "HEAD $card_path did not preserve raw JSON MIME/length/cache semantics" >&2; exit 1; }
for spec in 'POST|traveler-cards.json' 'GET|does-not-exist.json'; do
  method=${spec%%|*}; path=${spec#*|}
  status=$(curl --max-time 5 -sS -X "$method" -o /dev/null -w '%{http_code}' "$base/api/v1/$path")
  [ "$status" = 404 ] || { echo "$method /api/v1/$path returned $status, expected 404" >&2; exit 1; }
done
worker_cache=$(curl --max-time 5 -sS -I "$base/service-worker.js" | tr -d '\r' | sed -n 's/^[Cc]ache-[Cc]ontrol: //p' | tail -n 1)
[ "$worker_cache" = 'no-cache' ] || { echo "production service worker Cache-Control was '$worker_cache', expected no-cache" >&2; exit 1; }
manifest_type=$(curl --max-time 5 -sS -I "$base/manifest.webmanifest" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Tt]ype: //p' | tail -n 1)
[ "$manifest_type" = 'application/manifest+json; charset=utf-8' ] || { echo "production manifest MIME was '$manifest_type'" >&2; exit 1; }
icon_status=$(curl --max-time 5 -sS -o "$fixture/pwa-icon-512.png" -w '%{http_code}' "$base/pwa-icon-512.png")
[ "$icon_status" = 200 ] || { echo "production 512px PWA icon returned $icon_status" >&2; exit 1; }
node -e 'const fs=require("node:fs"),b=fs.readFileSync(process.argv[1]); if(b.readUInt32BE(16)!==512||b.readUInt32BE(20)!==512) process.exit(1)' "$fixture/pwa-icon-512.png" || { echo 'production PWA icon is not 512x512 PNG' >&2; exit 1; }
require_page /gateway/v1/README.md 'Foundation contract—not deployed' "$fixture/gateway-readme.md"
require_page /gateway/v1/openapi.json '0.1.0-foundation' "$fixture/gateway-openapi.json"
require_page /organizations/v1/README.md 'foundation design contract — not deployed' "$fixture/organizations-readme.md"
require_page /organizations/v1/openapi.json 'future-admin/organizations/v1' "$fixture/organizations-openapi.json"
require_page /managed-widget-config/v1/README.md 'STATIC/SYNTHETIC' "$fixture/managed-widget-config-readme.md"
require_page /managed-widget-config/v1/openapi.json 'managed-config-api.example.invalid' "$fixture/managed-widget-config-openapi.json"
require_page /technical-health/v1/README.md 'SYNTHETIC / NOT A SERVICE' "$fixture/technical-health-readme.md"
require_page /technical-health/v1/dashboard.schema.json 'technical-health-dashboard/v1' "$fixture/technical-health-dashboard-schema.json"
require_page /assurance-packs/v1/README.md 'STATIC/SYNTHETIC CONTRACT, NOT A SERVICE' "$fixture/assurance-pack-readme.md"
require_page /assurance-packs/v1/assurance-pack.schema.json 'data-assurance-pack/v1' "$fixture/assurance-pack-schema.json"
require_page /assurance-packs/v1/assurance-pack.synthetic.json 'static_synthetic_reference' "$fixture/assurance-pack.json"
require_page /reviewer-work-queue/v1/queue.schema.json 'reviewer-work-queue/v1' "$fixture/reviewer-work-queue-schema.json"
require_page /reviewer-work-queue/v1/disposition-audit.synthetic.json 'rwa_syn_example_0001' "$fixture/reviewer-work-queue-audit.json"
for assurance_file in README.md assurance-pack.schema.json assurance-pack.synthetic.json; do
  cmp "$fixture/${assurance_file#assurance-pack.}" "$repo_root/assurance-packs/contracts/v1/$assurance_file" >/dev/null 2>&1 || {
    case "$assurance_file" in
      README.md) downloaded="$fixture/assurance-pack-readme.md" ;;
      assurance-pack.schema.json) downloaded="$fixture/assurance-pack-schema.json" ;;
      assurance-pack.synthetic.json) downloaded="$fixture/assurance-pack.json" ;;
    esac
    cmp "$downloaded" "$repo_root/assurance-packs/contracts/v1/$assurance_file" >/dev/null || { echo "served assurance artifact differs from checked-in exact bytes: $assurance_file" >&2; exit 1; }
  }
done
organization_write_status=$(curl --max-time 5 -sS -X POST -o "$fixture/organizations-write.txt" -w '%{http_code}' "$base/organizations/v1/openapi.json")
[ "$organization_write_status" = 404 ] || { echo "POST static organization contract returned $organization_write_status" >&2; exit 1; }
technical_health_write_status=$(curl --max-time 5 -sS -X POST -o "$fixture/technical-health-write.txt" -w '%{http_code}' "$base/technical-health/v1/aggregate.synthetic.json")
[ "$technical_health_write_status" = 404 ] || { echo "POST static technical-health contract returned $technical_health_write_status" >&2; exit 1; }
assurance_pack_write_status=$(curl --max-time 5 -sS -X POST -o "$fixture/assurance-pack-write.txt" -w '%{http_code}' "$base/assurance-packs/v1/assurance-pack.synthetic.json")
[ "$assurance_pack_write_status" = 404 ] || { echo "POST static assurance pack returned $assurance_pack_write_status" >&2; exit 1; }
node - "$fixture/release.json" "$fixture/assurance-pack.json" "$fixture/artifacts.json" "$repo_root/assurance-packs/contracts/v1" "$fixture/api-manifest.json" "$card_body" <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

const descriptor = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const pack = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const indexBytes = readFileSync(process.argv[4]);
const index = JSON.parse(indexBytes);
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const identity = /^sha256:[0-9a-f]{64}$/;
const apiManifest = JSON.parse(readFileSync(process.argv[6], 'utf8'));
const cardBytes = readFileSync(process.argv[7]);
if (cardBytes.length > 1024 * 1024) { console.error('Served traveler-card JSON exceeds the 1048576-byte ceiling'); process.exit(1); }
const cardBundle = JSON.parse(cardBytes);
const valid = descriptor.schema_version === '1.0'
  && descriptor.canonical_origin === 'https://worldhotlines.org'
  && identity.test(descriptor.dataset_version)
  && identity.test(descriptor.release_id)
  && Number.isInteger(descriptor.artifact_index?.artifact_count)
  && descriptor.artifact_index.artifact_count > 0
  && descriptor.artifact_index.artifact_count === index.artifacts.length
  && descriptor.artifact_index.sha256 === digest(indexBytes)
  && descriptor.release_id === digest(Buffer.from(stable({ schema_version: descriptor.schema_version, canonical_origin: descriptor.canonical_origin, dataset_version: descriptor.dataset_version, build_versions: descriptor.build_versions, compatibility: descriptor.compatibility, artifact_index_sha256: descriptor.artifact_index.sha256 })))
  && descriptor.mutable_paths === true;
if (!valid) {
  console.error('Release descriptor failed structural validation');
  process.exit(1);
}
const byPath = new Map(index.artifacts.map((entry) => [entry.path, entry]));
const cardEntry = byPath.get('/api/v1/traveler-cards.json');
const metadataKeys = ['api_version', 'dataset_version', 'schema_version', 'generated_at', 'source_last_updated'];
const cardCodes = Object.keys(cardBundle.cards).sort();
const manifestCodes = apiManifest.countries.map(({ alpha2 }) => alpha2).sort();
const cardsValid = apiManifest.endpoints.traveler_cards === 'traveler-cards.json'
  && metadataKeys.every((key) => cardBundle[key] === apiManifest[key])
  && JSON.stringify(cardCodes) === JSON.stringify(manifestCodes)
  && cardCodes.length === apiManifest.total_countries
  && cardCodes.every((code) => typeof cardBundle.cards[code] === 'string' && cardBundle.cards[code].startsWith('EMERGENCY'))
  && cardEntry?.bytes === cardBytes.length
  && cardEntry.sha256 === digest(cardBytes)
  && JSON.stringify(descriptor.relationships['/api/v1/traveler-cards.json']) === JSON.stringify(cardEntry);
if (!cardsValid) { console.error('Served traveler-card JSON, metadata/card invariants, or release relationship failed'); process.exit(1); }
const packValid = pack.schema === 'data-assurance-pack/v1'
  && pack.pack_kind === 'static_synthetic_reference'
  && pack.release.release_id === 'sha256:da1a06c5b11b20fc76afa269c324ab869293cdd67d232cf62f05724dc1fc124a'
  && pack.release.artifact_index_sha256 === 'sha256:9964bddf9dbb99cd09f4be234619bf52b1dcc7eeec309f0874b45bc42db0156c'
  && pack.records.length === pack.coverage.record_count
  && pack.records.every((record) => record.uncertainty !== 'independently_reviewed' || record.evidence_summary.independently_accepted > 0)
  && pack.release.artifacts.every((entry, i, values) => i === 0 || values[i - 1].path < entry.path)
  && ['/assurance-packs/v1/README.md', '/assurance-packs/v1/assurance-pack.schema.json', '/assurance-packs/v1/assurance-pack.synthetic.json'].every((path) => {
    const entry = byPath.get(path); if (!entry || descriptor.relationships[path]?.sha256 !== entry.sha256) return false;
    const localName = path.slice('/assurance-packs/v1/'.length);
    const local = readFileSync(`${process.argv[5]}/${localName}`);
    return entry.bytes === local.length && entry.sha256 === `sha256:${createHash('sha256').update(local).digest('hex')}`;
  });
if (!packValid) { console.error('Assurance pack or current-release relationship validation failed'); process.exit(1); }
NODE

missing=/release/v1/does-not-exist.json
missing_status=$(curl --max-time 5 -sS -o "$fixture/missing.txt" -w '%{http_code}' "$base$missing")
[ "$missing_status" = 404 ] || { echo "GET $missing returned $missing_status, expected 404" >&2; exit 1; }
[ "$(cat "$fixture/missing.txt")" = 'Not found' ] || { echo "GET $missing did not return the stable 404 body" >&2; exit 1; }

echo "Deployment image OK: Docker build; raw traveler-card JSON GET/HEAD MIME, invariants, release hash/bytes, and read-only 404s; assurance and release relationships"
