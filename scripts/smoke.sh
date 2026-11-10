#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Signs up two users over HTTP and walks the invoicing flow: client, draft, send, numbering, immutability,
# ownership (other users get 404), share link, payment. Payments and webhook checks arrive with issue 9.2.
#   BASE_URL=https://app7.breakthruventures.ai ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
pass "health check"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
pass "pages render inside the shared shell"

for path in /dashboard /admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out dashboard and admin redirect"

signup() {
  local jar=$1 email=$2
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" \
    "$BASE_URL/api/auth/sign-up/email" >/dev/null || fail "sign-up failed for $email"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "two users signed up"

# ---------------------------------------------------------------------------
# Invoicing: clients, a draft with server-computed totals, send and numbering, immutability, ownership, share link.
# ---------------------------------------------------------------------------
# status of a request; extra curl args follow the URL-less prefix
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# jget '<path.to.value>' reads a field from JSON on stdin
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((a,k)=>a?.[k],JSON.parse(s));console.log(v==null?"":v)})' "$1"; }
post_a() { curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$2" "$BASE_URL$1"; }

[ "$(status "$BASE_URL/api/invoices")" = "401" ] || fail "anonymous invoice list should be 401"
[ "$(status "$BASE_URL/api/clients")" = "401" ] || fail "anonymous client list should be 401"
[ "$(status -b "$JAR_A" -H 'content-type: application/json' -H 'origin: https://evil.example' -d '{"name":"x"}' "$BASE_URL/api/clients")" = "403" ] || fail "cross-origin client create should be 403"
[ "$(status -b "$JAR_A" -H 'content-type: application/json' -d '{"name":"x"}' "$BASE_URL/api/clients")" = "403" ] || fail "client create without an Origin should be 403"
[ "$(status -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{nope' "$BASE_URL/api/clients")" = "400" ] || fail "malformed JSON should be 400"
code=$(head -c 40000 /dev/zero | tr '\0' 'x' | curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" --data-binary @- "$BASE_URL/api/clients")
[ "$code" = "413" ] || fail "oversized body should be 413, got $code"
pass "invoice API: signed-out, cross-origin, malformed and oversized requests refused"

client=$(post_a /api/clients '{"name":"Smoke Client","email":"ap@client.example","hourlyRateCents":10000}') || fail "create client failed"
client_id=$(echo "$client" | jget client.id)
[ -n "$client_id" ] || fail "no client id in $client"
pass "user A created a client"

draft=$(post_a /api/invoices "{\"clientId\":\"$client_id\",\"taxBp\":825,\"lines\":[{\"kind\":\"hours\",\"description\":\"Design\",\"quantityX100\":350,\"unitPriceCents\":10000},{\"kind\":\"expense\",\"description\":\"Test device\",\"quantityX100\":100,\"unitPriceCents\":12900}]}") || fail "create draft failed"
inv_id=$(echo "$draft" | jget invoice.id)
version=$(echo "$draft" | jget invoice.version)
[ -n "$inv_id" ] || fail "no invoice id in $draft"
# 3.5 h x $100.00 = 35,000 and 1 x $129.00 = 12,900: subtotal 47,900; tax 8.25% = 3,951.75 -> 3,952; total 51,852
[ "$(echo "$draft" | jget invoice.subtotalCents)" = "47900" ] || fail "subtotal should be 47900: $draft"
[ "$(echo "$draft" | jget invoice.taxCents)" = "3952" ] || fail "tax should be 3952: $draft"
[ "$(echo "$draft" | jget invoice.totalCents)" = "51852" ] || fail "total should be 51852: $draft"
[ "$(echo "$draft" | jget invoice.number)" = "" ] || fail "a draft must have no number: $draft"
pass "draft with two lines; totals computed on the server"

[ "$(status -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"totalCents":1}' "$BASE_URL/api/invoices")" = "400" ] || fail "client-supplied totals should be 400"
pass "client-supplied totals refused"

sent=$(post_a "/api/invoices/$inv_id/transition" "{\"to\":\"sent\",\"version\":$version}") || fail "send failed"
[ "$(echo "$sent" | jget invoice.number)" = "INV-0001" ] || fail "first sent invoice should be INV-0001: $sent"
[ "$(echo "$sent" | jget invoice.status)" = "sent" ] || fail "invoice should be sent: $sent"
share_url=$(echo "$sent" | jget shareUrl)
token="${share_url##*/i/}"
[ "${#token}" = "43" ] || fail "share token should be 43 characters, got: $share_url"
version=$(echo "$sent" | jget invoice.version)
pass "send -> INV-0001 with a share link"

code=$(status -X PATCH -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"version\":$version,\"memo\":\"sneaky\"}" "$BASE_URL/api/invoices/$inv_id")
[ "$code" = "409" ] || fail "editing a sent invoice should be 409, got $code"
code=$(status -X DELETE -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/invoices/$inv_id")
[ "$code" = "409" ] || fail "deleting a sent invoice should be 409, got $code"
pass "sent invoice is immutable"

for target in "GET /api/invoices/$inv_id" "GET /api/clients/$client_id"; do
  code=$(status -b "$JAR_B" "$BASE_URL${target#* }")
  [ "$code" = "404" ] || fail "user B on A's ${target#* } should be 404, got $code"
done
# method path body: each body is valid for its route, so a 404 can only come from ownership
while IFS='|' read -r method path body; do
  code=$(status -X "$method" -b "$JAR_B" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$body" "$BASE_URL$path")
  [ "$code" = "404" ] || fail "user B on A's $method $path should be 404, got $code"
done <<LIST
PATCH|/api/invoices/$inv_id|{"version":$version,"memo":"x"}
DELETE|/api/invoices/$inv_id|
POST|/api/invoices/$inv_id/payments|{"version":$version}
POST|/api/invoices/$inv_id/share|
DELETE|/api/invoices/$inv_id/share|
POST|/api/invoices/$inv_id/transition|{"to":"void","version":$version,"reason":"x"}
POST|/api/invoices/$inv_id/duplicate|
PATCH|/api/clients/$client_id|{"name":"x"}
DELETE|/api/clients/$client_id|
LIST
list_b=$(curl -fsS -b "$JAR_B" "$BASE_URL/api/invoices")
echo "$list_b" | grep -q '"invoices":\[\]' || fail "user B's invoice list should be empty: $list_b"
pass "user B gets 404 on A's invoice, client, payments, share and transitions"

pub_headers=$(mktemp); trap 'rm -f "$JAR_A" "$JAR_B" "$pub_headers"' EXIT
pub=$(curl -fsS -D "$pub_headers" "$BASE_URL/api/public/invoices/$token") || fail "share link did not open without a session"
[ "$(echo "$pub" | jget invoice.number)" = "INV-0001" ] || fail "public invoice should be INV-0001: $pub"
[ "$(echo "$pub" | jget invoice.totalCents)" = "51852" ] || fail "public total should be 51852: $pub"
echo "$pub" | grep -q 'ap@client.example' && fail "public invoice leaked the client's email: $pub"
grep -qi '^cache-control: private, no-store' "$pub_headers" || fail "public invoice should be private, no-store"
grep -qi '^referrer-policy: no-referrer' "$pub_headers" || fail "public invoice should send no-referrer"
grep -qi '^x-robots-tag: noindex' "$pub_headers" || fail "public invoice should be noindex"
[ "$(status "$BASE_URL/api/public/invoices/$(printf 'a%.0s' $(seq 43))")" = "404" ] || fail "unknown token should be 404"
pass "share link opens without a session, with private headers and no client email"

rotated=$(post_a "/api/invoices/$inv_id/share" '{}') || fail "rotate failed"
new_token="$(echo "$rotated" | jget shareUrl)"; new_token="${new_token##*/i/}"
[ "$(status "$BASE_URL/api/public/invoices/$token")" = "404" ] || fail "rotated token should 404 at once"
[ "$(status "$BASE_URL/api/public/invoices/$new_token")" = "200" ] || fail "new token should open"
pass "rotating the share link kills the old one"

paid=$(post_a "/api/invoices/$inv_id/payments" "{\"version\":$version,\"note\":\"smoke\"}") || fail "manual payment failed"
[ "$(echo "$paid" | jget invoice.status)" = "paid" ] || fail "invoice should be paid: $paid"
[ "$(echo "$paid" | jget invoice.paidCents)" = "51852" ] || fail "paid cents should be 51852: $paid"
[ "$(curl -fsS "$BASE_URL/api/public/invoices/$new_token" | jget invoice.status)" = "paid" ] || fail "public page should show paid"
pass "manual payment of the full balance marks the invoice paid"

code=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"notes":"6h","clientRateCents":10000}' "$BASE_URL/api/invoices/draft-from-notes")
[ "$code" = "401" ] || fail "anonymous draft-from-notes should be 401, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H 'origin: https://evil.example' \
  -d '{"notes":"6h","clientRateCents":10000}' "$BASE_URL/api/invoices/draft-from-notes")
[ "$code" = "403" ] || fail "cross-origin draft-from-notes should be 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"notes":"","clientRateCents":10000}' "$BASE_URL/api/invoices/draft-from-notes")
[ "$code" = "400" ] || fail "empty notes should be 400, got $code"
draft=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"notes":"Homepage redesign: 6h on layout and responsive fixes\nLogo refresh, flat fee $450","clientRateCents":10000}' \
  "$BASE_URL/api/invoices/draft-from-notes") || fail "draft-from-notes failed"
echo "$draft" | grep -q '"lines":\[' || fail "draft has no lines array: $draft"
echo "$draft" | grep -Eq '"subtotalCents":[0-9]+' || fail "draft has no subtotalCents: $draft"
# Only the recorded demo answer has a known total; a live model's lines vary.
if echo "$draft" | grep -q '"demo":true'; then
  echo "$draft" | grep -q '"subtotalCents":105000' || fail "demo draft subtotal should be 105000 (computed server-side), got: $draft"
fi
pass "draft from notes: auth, origin, validation and server-computed subtotal"

echo "SMOKE PASS"
