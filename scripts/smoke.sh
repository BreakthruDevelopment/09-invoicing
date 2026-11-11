#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Signs up two users over HTTP and walks the invoicing flow: client, draft, send, numbering, immutability,
# ownership (other users get 404, including the PDF), the invoice PDF for the owner and the share link,
# share link, manual payment, the payer's checkout and demo payment, the signed
# webhook (a bad signature is refused), and the health `payments` mode. Needs no Stripe keys: without them the app
# runs the demo provider; with test keys configured the demo steps are replaced by checks that demo-pay is off.
#   BASE_URL=https://app7.breakthruventures.ai ./scripts/smoke.sh
set -euo pipefail
# macOS bash 3.2 brace-expands JSON objects inside "$()" even when the quotes look escaped. Leave {a,b} alone.
set +B

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"
PDF_HEADERS="$(mktemp)"; PDF_BODY="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B" "$PDF_HEADERS" "$PDF_BODY"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
# jget '<path.to.value>' reads a field from JSON on stdin
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((a,k)=>a?.[k],JSON.parse(s));console.log(v==null?"":v)})' "$1"; }
pass() { echo "ok - $*"; }
# Download a PDF and check the attachment headers plus the %PDF- magic. The filename is the only user-facing name.
fetch_pdf() {
  local name=$1; shift
  local code
  code=$(curl -s -D "$PDF_HEADERS" -o "$PDF_BODY" -w '%{http_code}' "$@")
  [ "$code" = "200" ] || fail "pdf $name should be 200, got $code: $(head -c 180 "$PDF_BODY")"
  grep -qi '^content-type: application/pdf' "$PDF_HEADERS" || fail "pdf $name content-type: $(grep -i '^content-type:' "$PDF_HEADERS" || true)"
  grep -qi "^content-disposition: attachment; filename=\"${name}\"" "$PDF_HEADERS" || fail "pdf $name disposition: $(grep -i '^content-disposition:' "$PDF_HEADERS" || true)"
  grep -qi '^x-content-type-options: nosniff' "$PDF_HEADERS" || fail "pdf $name should be nosniff"
  grep -qi '^cache-control: private, no-store' "$PDF_HEADERS" || fail "pdf $name should be private, no-store"
  head -c 5 "$PDF_BODY" | grep -q '%PDF-' || fail "pdf $name should start with %PDF-"
}

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
pass "health check"
payments_mode=$(echo "$health" | jget payments)
case "$payments_mode" in demo|stripe) ;; *) fail "health should report payments demo|stripe, got: $health" ;; esac
echo "$health" | grep -Eq 'sk_|rk_|whsec_' && fail "health leaked a payment secret: $health"
pass "health reports payments: $payments_mode"

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

for path in /invoices /invoices/new /clients /settings; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out invoice, client and settings pages redirect"

home=$(curl -fsS "$BASE_URL/") || fail "home page did not render"
echo "$home" | grep -q 'No real money moves' || fail "home page is missing the demo banner"
pass "home page explains the demo"

signup() {
  local jar=$1 email=$2
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" \
    "$BASE_URL/api/auth/sign-up/email" >/dev/null || fail "sign-up failed for $email"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "two users signed up"

for path in /invoices /invoices/new /clients /settings; do
  page=$(curl -fsS -b "$JAR_A" "$BASE_URL$path") || fail "signed-in $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "signed-in $path is missing the shared footer"
done
echo "$page" | grep -q 'Business profile' || fail "settings page did not render"
inv_page=$(curl -fsS -b "$JAR_A" "$BASE_URL/invoices")
echo "$inv_page" | grep -q 'Outstanding' || fail "invoice list is missing the outstanding total"
pass "signed-in invoice pages render inside the shared shell"

# ---------------------------------------------------------------------------
# Invoicing: clients, a draft with server-computed totals, send and numbering, immutability, ownership, share link.
# ---------------------------------------------------------------------------
# status of a request; extra curl args follow the URL-less prefix
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
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

editor=$(curl -fsS -b "$JAR_A" "$BASE_URL/invoices/$inv_id") || fail "invoice editor did not render"
echo "$editor" | grep -q '518.52' || fail "editor should show the server total 518.52"
echo "$editor" | grep -q 'Design' || fail "editor should show the saved line"
echo "$editor" | grep -q "/api/invoices/$inv_id/pdf" || fail "editor should link to the invoice PDF"
pass "invoice editor shows the saved line and the server total"
fetch_pdf "draft.pdf" -b "$JAR_A" "$BASE_URL/api/invoices/$inv_id/pdf" || fail "owner draft pdf"
[ "$(status "$BASE_URL/api/invoices/$inv_id/pdf")" = "401" ] || fail "anonymous invoice pdf should be 401"
pass "owner downloads the draft PDF as draft.pdf; anonymous is 401"

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

html_headers=$(mktemp)
html=$(curl -fsS -D "$html_headers" "$BASE_URL/i/$token") || fail "public invoice page did not render"
echo "$html" | grep -q 'INV-0001' || fail "public page should show INV-0001"
echo "$html" | grep -q 'Smoke Client' || fail "public page should name the client"
echo "$html" | grep -q 'ap@client.example' && fail "public page leaked the client email"
echo "$html" | grep -q "/i/$token/pdf" || fail "public page should link to its PDF"
echo "$html" | grep -q 'Explore breakthruventures.ai' || fail "public page is missing the shared footer"
grep -qi '^cache-control: private, no-store' "$html_headers" || fail "public page should be private, no-store"
grep -qi '^referrer-policy: no-referrer' "$html_headers" || fail "public page should send no-referrer"
grep -qi '^x-robots-tag: noindex' "$html_headers" || fail "public page should be noindex"
if [ "$payments_mode" = "demo" ]; then
  echo "$html" | grep -q 'Pay (demo)' || fail "public page should offer Pay (demo)"
fi
rm -f "$html_headers"
[ "$(status "$BASE_URL/i/$(printf 'a%.0s' $(seq 43))")" = "404" ] || fail "unknown token page should be 404"
pass "public invoice page renders without a session"

code=$(status -X PATCH -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"version\":$version,\"memo\":\"sneaky\"}" "$BASE_URL/api/invoices/$inv_id")
[ "$code" = "409" ] || fail "editing a sent invoice should be 409, got $code"
code=$(status -X DELETE -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/invoices/$inv_id")
[ "$code" = "409" ] || fail "deleting a sent invoice should be 409, got $code"
pass "sent invoice is immutable"

for target in "GET /api/invoices/$inv_id" "GET /api/invoices/$inv_id/pdf" "GET /api/clients/$client_id"; do
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
pass "user B gets 404 on A's invoice, PDF, client, payments, share and transitions"

pub_headers=$(mktemp); trap 'rm -f "$JAR_A" "$JAR_B" "$PDF_HEADERS" "$PDF_BODY" "$pub_headers"' EXIT
pub=$(curl -fsS -D "$pub_headers" "$BASE_URL/api/public/invoices/$token") || fail "share link did not open without a session"
[ "$(echo "$pub" | jget invoice.number)" = "INV-0001" ] || fail "public invoice should be INV-0001: $pub"
[ "$(echo "$pub" | jget invoice.totalCents)" = "51852" ] || fail "public total should be 51852: $pub"
echo "$pub" | grep -q 'ap@client.example' && fail "public invoice leaked the client's email: $pub"
grep -qi '^cache-control: private, no-store' "$pub_headers" || fail "public invoice should be private, no-store"
grep -qi '^referrer-policy: no-referrer' "$pub_headers" || fail "public invoice should send no-referrer"
grep -qi '^x-robots-tag: noindex' "$pub_headers" || fail "public invoice should be noindex"
[ "$(status "$BASE_URL/api/public/invoices/$(printf 'a%.0s' $(seq 43))")" = "404" ] || fail "unknown token should be 404"
pass "share link opens without a session, with private headers and no client email"

fetch_pdf "INV-0001.pdf" -b "$JAR_A" "$BASE_URL/api/invoices/$inv_id/pdf" || fail "owner sent pdf"
fetch_pdf "INV-0001.pdf" "$BASE_URL/i/$token/pdf" || fail "public pdf"
grep -qi '^referrer-policy: no-referrer' "$PDF_HEADERS" || fail "public pdf should send no-referrer"
grep -qi '^x-robots-tag: noindex' "$PDF_HEADERS" || fail "public pdf should be noindex"
unk=$(curl -s -D "$PDF_HEADERS" -o "$PDF_BODY" -w '%{http_code}' "$BASE_URL/i/$(printf 'a%.0s' $(seq 43))/pdf")
[ "$unk" = "404" ] || fail "unknown token pdf should be 404, got $unk"
grep -q '{"error":"Not found"}' "$PDF_BODY" || fail "unknown token pdf body: $(head -c 180 "$PDF_BODY")"
grep -qi '^content-disposition:' "$PDF_HEADERS" && fail "a missing pdf must not set a filename"
grep -qi '^cache-control: private, no-store' "$PDF_HEADERS" || fail "unknown token pdf should be private, no-store"
pass "owner and share-link PDFs are INV-0001.pdf; an unknown token is the same 404"

rotated=$(post_a "/api/invoices/$inv_id/share" '{}') || fail "rotate failed"
new_token="$(echo "$rotated" | jget shareUrl)"; new_token="${new_token##*/i/}"
[ "$(status "$BASE_URL/api/public/invoices/$token")" = "404" ] || fail "rotated token should 404 at once"
[ "$(status "$BASE_URL/api/public/invoices/$new_token")" = "200" ] || fail "new token should open"
[ "$(status "$BASE_URL/i/$token/pdf")" = "404" ] || fail "rotated token pdf should 404 at once"
fetch_pdf "INV-0001.pdf" "$BASE_URL/i/$new_token/pdf" || fail "new token pdf"
pass "rotating the share link kills the old JSON and the old PDF"

paid=$(post_a "/api/invoices/$inv_id/payments" "{\"version\":$version,\"note\":\"smoke\"}") || fail "manual payment failed"
[ "$(echo "$paid" | jget invoice.status)" = "paid" ] || fail "invoice should be paid: $paid"
[ "$(echo "$paid" | jget invoice.paidCents)" = "51852" ] || fail "paid cents should be 51852: $paid"
[ "$(curl -fsS "$BASE_URL/api/public/invoices/$new_token" | jget invoice.status)" = "paid" ] || fail "public page should show paid"
pass "manual payment of the full balance marks the invoice paid"

# ---------------------------------------------------------------------------
# Payments: the payer pays through the share link only; the webhook refuses unsigned calls.
# ---------------------------------------------------------------------------
pay_draft=$(post_a /api/invoices "{\"clientId\":\"$client_id\",\"lines\":[{\"kind\":\"fixed\",\"description\":\"Logo refresh\",\"quantityX100\":100,\"unitPriceCents\":45000}]}") || fail "create second draft failed"
pay_id=$(echo "$pay_draft" | jget invoice.id)
pay_sent=$(post_a "/api/invoices/$pay_id/transition" "{\"to\":\"sent\",\"version\":$(echo "$pay_draft" | jget invoice.version)}") || fail "send second invoice failed"
pay_token="$(echo "$pay_sent" | jget shareUrl)"; pay_token="${pay_token##*/i/}"

# Default body is `{}`. A ${var:-{\}} default keeps the backslash on macOS bash 3.2, and that is not JSON.
pub_post() {
  local origin="${3:-$BASE_URL}"
  local data="${4-}"
  if [ -z "$data" ]; then data='{}'; fi
  curl -s -o "$2" -w '%{http_code}' -X POST -H 'content-type: application/json' -H "origin: $origin" -d "$data" "$BASE_URL$1"
}
body_file=$(mktemp); trap 'rm -f "$JAR_A" "$JAR_B" "$PDF_HEADERS" "$PDF_BODY" "$pub_headers" "$body_file"' EXIT

[ "$(pub_post "/i/$pay_token/checkout" "$body_file" https://evil.example)" = "403" ] || fail "cross-origin checkout should be 403"
[ "$(pub_post "/i/$pay_token/checkout" "$body_file" "$BASE_URL" '{"amountCents":1}')" = "400" ] || fail "checkout must not accept an amount"
unk_checkout=$(pub_post "/i/$(printf 'a%.0s' $(seq 43))/checkout" "$body_file")
[ "$unk_checkout" = "404" ] || fail "checkout on an unknown token should be 404, got $unk_checkout: $(head -c 180 "$body_file")"
[ "$(pub_post "/i/$new_token/checkout" "$body_file")" = "409" ] || fail "checkout on a paid invoice should be 409"

if [ "$payments_mode" = "demo" ]; then
  demo_html=$(curl -fsS "$BASE_URL/i/$pay_token/demo-pay") || fail "demo pay page did not render"
  echo "$demo_html" | grep -q 'Demo payment, no money moves' || fail "demo pay page should say no money moves"
  echo "$demo_html" | grep -q 'Explore breakthruventures.ai' || fail "demo pay page is missing the shared footer"
  pass "demo pay page renders"
  [ "$(pub_post "/i/$pay_token/checkout" "$body_file")" = "200" ] || fail "demo checkout failed: $(cat "$body_file")"
  [ "$(jget provider < "$body_file")" = "demo" ] || fail "checkout should pick the demo provider: $(cat "$body_file")"
  [ "$(jget url < "$body_file")" = "$BASE_URL/i/$pay_token/demo-pay" ] || fail "demo checkout url unexpected: $(cat "$body_file")"
  [ "$(curl -fsS "$BASE_URL/api/public/invoices/$pay_token" | jget invoice.status)" = "sent" ] || fail "starting checkout must not mark the invoice paid"
  [ "$(pub_post "/api/public/invoices/$pay_token/demo-pay" "$body_file" https://evil.example)" = "403" ] || fail "cross-origin demo-pay should be 403"
  [ "$(pub_post "/api/public/invoices/$pay_token/demo-pay" "$body_file")" = "200" ] || fail "demo pay failed: $(cat "$body_file")"
  [ "$(curl -fsS "$BASE_URL/api/public/invoices/$pay_token" | jget invoice.status)" = "paid" ] || fail "demo pay should mark the invoice paid"
  curl -fsS "$BASE_URL/i/$pay_token" | grep -q 'Paid' || fail "public page should show the invoice as paid"
  [ "$(pub_post "/api/public/invoices/$pay_token/demo-pay" "$body_file")" = "409" ] || fail "a second demo pay should be 409"
  paid_a=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/invoices/$pay_id")
  [ "$(echo "$paid_a" | jget invoice.status)" = "paid" ] || fail "owner should see the invoice paid: $paid_a"
  [ "$(echo "$paid_a" | jget payments.0.method)" = "demo" ] || fail "payment should be a demo payment: $paid_a"
  [ "$(echo "$paid_a" | jget payments.0.amountCents)" = "45000" ] || fail "demo payment should be the full balance: $paid_a"
  [ "$(echo "$paid_a" | jget payments.1)" = "" ] || fail "demo pay should record exactly one payment: $paid_a"
  pass "payer opens checkout, confirms the demo payment: invoice paid once, for the full balance"
else
  [ "$(pub_post "/api/public/invoices/$pay_token/demo-pay" "$body_file")" = "404" ] || fail "demo pay must be off when Stripe is configured"
  pass "Stripe configured: demo pay is off"
fi

[ "$(status -X POST -H 'content-type: application/json' -H 'stripe-signature: t=1,v1=0000000000000000000000000000000000000000000000000000000000000000' -d '{"id":"evt_smoke","type":"checkout.session.completed","livemode":false,"data":{"object":{}}}' "$BASE_URL/api/stripe/webhook")" = "400" ] || fail "webhook with a bad signature should be 400"
[ "$(status -X POST -H 'content-type: application/json' -d '{}' "$BASE_URL/api/stripe/webhook")" = "400" ] || fail "webhook without a signature should be 400"
pass "webhook refuses a bad or missing signature"

# Draft from notes and "Add to invoice". The rate comes from the client on the server; the browser sends ids only.
DN="$BASE_URL/api/invoices/draft-from-notes"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"notes\":\"6h\",\"clientId\":\"$client_id\"}" "$DN")
[ "$code" = "401" ] || fail "anonymous draft-from-notes should be 401, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H 'origin: https://evil.example' \
  -d "{\"notes\":\"6h\",\"clientId\":\"$client_id\"}" "$DN")
[ "$code" = "403" ] || fail "cross-origin draft-from-notes should be 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"notes\":\"\",\"clientId\":\"$client_id\"}" "$DN")
[ "$code" = "400" ] || fail "empty notes should be 400, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"notes\":\"6h\",\"clientId\":\"$client_id\",\"clientRateCents\":99999}" "$DN")
[ "$code" = "400" ] || fail "a rate from the browser should be 400, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_B" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"notes\":\"6h\",\"clientId\":\"$client_id\"}" "$DN")
[ "$code" = "404" ] || fail "user B drafting against A's client should be 404, got $code"
NOTES='Homepage redesign: 6h on layout and responsive fixes\nLogo refresh, flat fee $450'
draft=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"notes\":\"$NOTES\",\"clientId\":\"$client_id\"}" "$DN") || fail "draft-from-notes failed"
echo "$draft" | grep -q '"lines":\[' || fail "draft has no lines array: $draft"
echo "$draft" | grep -Eq '"subtotalCents":[0-9]+' || fail "draft has no subtotalCents: $draft"
draft_id=$(echo "$draft" | jget draft.draftId)
[ -n "$draft_id" ] || fail "draft has no draftId: $draft"
echo "$draft" | grep -Eq '"period":\{"from":"[0-9-]{10}","to":"[0-9-]{10}"\}' || fail "draft has no period: $draft"
# Only the recorded demo answer has a known total (client rate $100/h from the client row); a live model's lines vary.
is_demo=0
if echo "$draft" | grep -q '"demo":true'; then
  is_demo=1
  echo "$draft" | grep -q '"subtotalCents":105000' || fail "demo draft subtotal should be 105000 (computed server-side), got: $draft"
fi
pass "draft from notes: auth, origin, validation, rate looked up from the client, saved with an id"

# Add to invoice: draft invoices only, owner only, ids and indexes only, single-use.
ai_draft=$(post_a /api/invoices "{\"clientId\":\"$client_id\",\"lines\":[{\"kind\":\"expense\",\"description\":\"Domain\",\"quantityX100\":100,\"unitPriceCents\":1500}]}") || fail "create AI target draft failed"
ai_id=$(echo "$ai_draft" | jget invoice.id); ai_ver=$(echo "$ai_draft" | jget invoice.version)
AL="$BASE_URL/api/invoices/$ai_id/draft-lines"
[ "$(status -X POST -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{}' "$AL")" = "401" ] || fail "anonymous add-to-invoice should be 401"
[ "$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H 'origin: https://evil.example' -d '{}' "$AL")" = "403" ] || fail "cross-origin add-to-invoice should be 403"
# JSON stays in a variable. Inside "$(...)", bash 3.2 splits a \"{...}\" argument on commas.
add_body=$(printf '{"draftId":"%s","lineIndexes":[0],"version":%s}' "$draft_id" "$ai_ver")
code=$(status -X POST -b "$JAR_B" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$add_body" "$AL")
[ "$code" = "404" ] || fail "user B adding to A's invoice should be 404, got $code"
tamper_body=$(printf '{"draftId":"%s","lineIndexes":[0],"version":%s,"unitPriceCents":1,"amountCents":1,"source":"manual"}' "$draft_id" "$ai_ver")
code=$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$tamper_body" "$AL")
[ "$code" = "400" ] || fail "amounts or source from the browser should be 400, got $code"
stale_body=$(printf '{"draftId":"%s","lineIndexes":[0],"version":%s}' "$draft_id" "$((ai_ver + 5))")
code=$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$stale_body" "$AL")
[ "$code" = "409" ] || fail "a stale version should be 409, got $code"
if [ "$is_demo" = "1" ]; then
  added=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"draftId\":\"$draft_id\",\"lineIndexes\":[0,1],\"version\":$ai_ver}" "$AL") || fail "add to invoice failed"
  # $15 manual + 6 h x $100 + flat $450, all computed on the server
  [ "$(echo "$added" | jget invoice.subtotalCents)" = "106500" ] || fail "subtotal after add should be 106500: $added"
  [ "$(echo "$added" | jget lines.1.source)" = "ai" ] || fail "added lines should be source ai: $added"
  [ "$(echo "$added" | jget lines.2.source)" = "ai" ] || fail "added lines should be source ai: $added"
  [ "$(echo "$added" | jget invoice.version)" = "$((ai_ver + 1))" ] || fail "version should go up by one: $added"
  again_body=$(printf '{"draftId":"%s","lineIndexes":[0],"version":%s}' "$draft_id" "$((ai_ver + 1))")
  code=$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$again_body" "$AL")
  [ "$code" = "409" ] || fail "adding the same draft twice should be 409, got $code"
  sent_ai=$(post_a "/api/invoices/$ai_id/transition" "{\"to\":\"sent\",\"version\":$((ai_ver + 1))}") || fail "send AI invoice failed"
  draft2=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"notes\":\"$NOTES\",\"clientId\":\"$client_id\"}" "$DN") || fail "second draft failed"
  sent_body=$(printf '{"draftId":"%s","lineIndexes":[0],"version":%s}' "$(echo "$draft2" | jget draft.draftId)" "$(echo "$sent_ai" | jget invoice.version)")
  code=$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$sent_body" "$AL")
  [ "$code" = "409" ] || fail "a sent invoice must not take lines (409), got $code"
  pass "add to invoice: server-derived amounts, source ai, version bump, single-use, drafts only, owner only"
else
  pass "add to invoice: auth, ownership, tampering and stale-version refusals (live model: lines vary, amounts not asserted)"
fi

echo "SMOKE PASS"
