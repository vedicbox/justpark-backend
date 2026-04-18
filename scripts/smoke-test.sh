#!/bin/bash
set -e

API_BASE="${API_BASE:-http://localhost:3000/api/v1}"
echo "Testing API at $API_BASE"

# 1. Health check
echo "--- Health check ---"
curl -sf "$API_BASE/../health" || echo "WARN: No /health endpoint"

# 2. Firebase verify route exists (should return 400 or 422, not 404)
echo "--- Auth: Firebase verify route ---"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_BASE/auth/firebase/verify" \
  -H "Content-Type: application/json" -d '{}')
if [ "$STATUS" = "404" ]; then
  echo "FAIL: /auth/firebase/verify returned 404 — wrong backend?"
  exit 1
fi
echo "OK: returned $STATUS"

# 3. Admin login route exists
echo "--- Auth: Admin login route ---"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_BASE/auth/admin/login" \
  -H "Content-Type: application/json" -d '{}')
if [ "$STATUS" = "404" ]; then
  echo "FAIL: /auth/admin/login returned 404"
  exit 1
fi
echo "OK: returned $STATUS"

# 4. OTP send rejects phone_verify purpose
echo "--- Auth: OTP rejects phone_verify ---"
BODY=$(curl -s -X POST "$API_BASE/auth/otp/send" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+1234567890","purpose":"phone_verify"}')
echo "$BODY" | grep -qi "error\|invalid\|firebase" && echo "OK: phone_verify rejected" \
  || echo "WARN: phone_verify may still be accepted"

# 5. Spaces search is accessible
echo "--- Spaces: search endpoint ---"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$API_BASE/spaces/search?lat=28.6&lng=77.3")
echo "Spaces search: $STATUS"

echo ""
echo "=== Smoke test complete ==="
