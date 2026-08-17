#!/usr/bin/env bash
set -euo pipefail

# Adaugă / actualizează ruta publică bubblebim.ciuntucbimstudio.ro în tunelul Cloudflare existent.
# Necesită token API Cloudflare cu permisiuni: Cloudflare Tunnel Edit + DNS Edit.
#
# Utilizare:
#   CLOUDFLARE_API_TOKEN=... ./deploy/setup-cloudflare-route.sh
#   sau: source deploy/.env.deploy && ./deploy/setup-cloudflare-route.sh

HOSTNAME="${BUBBLEBIM_HOSTNAME:-bubblebim.ciuntucbimstudio.ro}"
SERVICE="${BUBBLEBIM_SERVICE:-http://127.0.0.1:3458}"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-31fd964ceb9ed68b9d5c840d05c3582}"
TUNNEL_ID="${CLOUDFLARE_TUNNEL_ID:-284c6fe2-d571-4c7f-82d4-812b66d8d520}"
API_TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "${SCRIPT_DIR}/.env.deploy" ]]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/.env.deploy"
  API_TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}"
fi

if [[ -z "${API_TOKEN}" ]]; then
  echo "Eroare: setează CLOUDFLARE_API_TOKEN (sau creează deploy/.env.deploy)."
  echo "  Cloudflare Dashboard → My Profile → API Tokens → Create Token"
  echo "  Permisiuni: Account → Cloudflare Tunnel → Edit, Zone → DNS → Edit"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Eroare: jq nu este instalat (brew install jq)."
  exit 1
fi

API_BASE="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations"

echo "→ Verific token Cloudflare..."
verify="$(curl -fsS "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer ${API_TOKEN}")"
if [[ "$(echo "${verify}" | jq -r '.success')" != "true" ]]; then
  echo "Token invalid: $(echo "${verify}" | jq -r '.errors[0].message // "unknown"')"
  exit 1
fi

echo "→ Citesc configurația curentă a tunelului..."
current="$(curl -fsS "${API_BASE}" -H "Authorization: Bearer ${API_TOKEN}")"
if [[ "$(echo "${current}" | jq -r '.success')" != "true" ]]; then
  echo "Nu pot citi tunelul: $(echo "${current}" | jq -r '.errors[0].message // "unknown"')"
  exit 1
fi

ingress="$(echo "${current}" | jq '.result.config.ingress // []')"
if [[ "${ingress}" == "null" || "${ingress}" == "[]" ]]; then
  ingress='[]'
fi

updated="$(echo "${ingress}" | jq \
  --arg host "${HOSTNAME}" \
  --arg svc "${SERVICE}" \
  '
    (map(select(.hostname != null and .hostname != $host))
    + [{hostname: $host, service: $svc, originRequest: {}}]
    + [{service: "http_status:404"}])
  ')"

payload="$(jq -n --argjson ingress "${updated}" '{config: {ingress: $ingress}}')"

echo "→ Actualizez rutele tunelului (${HOSTNAME} → ${SERVICE})..."
put="$(curl -fsS "${API_BASE}" \
  -X PUT \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "${payload}")"

if [[ "$(echo "${put}" | jq -r '.success')" != "true" ]]; then
  echo "Eroare la update: $(echo "${put}" | jq -r '.errors[0].message // "unknown"')"
  exit 1
fi

echo "→ Aștept propagarea (15s)..."
sleep 15

echo "→ Test HTTPS..."
if curl -fsSI "https://${HOSTNAME}/" | head -1 | grep -qE '200|301|302'; then
  echo "✓ https://${HOSTNAME} răspunde OK"
else
  echo "⚠ Ruta e configurată, dar HTTPS nu răspunde încă."
  echo "  Verifică pe server: curl -I http://127.0.0.1:3458/"
  echo "  DNS CNAME: ${HOSTNAME} → ${TUNNEL_ID}.cfargotunnel.com"
fi

echo ""
echo "Rute active:"
echo "${updated}" | jq -r '.[] | select(.hostname != null) | "  \(.hostname) → \(.service)"'
