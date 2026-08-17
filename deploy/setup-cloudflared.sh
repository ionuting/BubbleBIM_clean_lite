#!/usr/bin/env bash
set -euo pipefail

# Instalează cloudflared pe serverul BubbleBIM și pornește connectorul.
# Tokenul îl iei din Cloudflare Zero Trust → Networks → Tunnels →
#   Create / Configure tunnel → Install connector → copiază comanda/tokenul.
#
# Utilizare (de pe Mac):
#   BUBBLEBIM_TUNNEL_TOKEN="eyJ..." ./deploy/setup-cloudflared.sh
# sau pe server:
#   BUBBLEBIM_TUNNEL_TOKEN="eyJ..." bash /opt/bubblebim/deploy/setup-cloudflared.sh

TOKEN="${BUBBLEBIM_TUNNEL_TOKEN:-${TUNNEL_TOKEN:-}}"
SERVER="${DEPLOY_SERVER:-root@YOUR_SERVER_IP}"
SERVICE_NAME="cloudflared-bubblebim"

if [[ -z "${TOKEN}" ]]; then
  echo "Eroare: setează BUBBLEBIM_TUNNEL_TOKEN."
  echo ""
  echo "Pași în Cloudflare:"
  echo "  1. Zero Trust → Networks → Tunnels → Create a tunnel (nume: bubblebim-hetzner)"
  echo "  2. Cloudflared → Docker sau Debian → copiază tokenul"
  echo "  3. Public Hostname:"
  echo "       Subdomain: bubblebim"
  echo "       Domain:    ciuntucbimstudio.ro"
  echo "       Service:   http://127.0.0.1:3458"
  echo "  4. Șterge hostname-ul bubblebim din tunelul vechi ollama-hetzner (altfel conflict)"
  echo "  5. BUBBLEBIM_TUNNEL_TOKEN=... ./deploy/setup-cloudflared.sh"
  exit 1
fi

# Dacă rulează deja pe server (invocat local pe Hetzner)
if [[ "$(hostname -I 2>/dev/null | tr -d ' ')" == *"YOUR_SERVER_IP"* ]] || [[ -f /opt/bubblebim/deploy/setup-cloudflared.sh && "$(pwd)" == /opt/bubblebim* ]]; then
  REMOTE=0
else
  REMOTE=1
fi

install_local() {
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "→ Instalez cloudflared..."
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
    . /etc/os-release
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared ${VERSION_CODENAME:-jammy} main" \
      | tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
    apt-get update -qq
    apt-get install -y cloudflared
  fi

  UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
  cat > "${UNIT}" <<EOF
[Unit]
Description=cloudflared — tunel BubbleBIM (bubblebim.ciuntucbimstudio.ro)
After=network-online.target
Wants=network-online.target

[Service]
TimeoutStartSec=15
Type=notify
ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token ${TOKEN}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"
  sleep 3

  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo "✓ ${SERVICE_NAME} activ"
    journalctl -u "${SERVICE_NAME}" -n 10 --no-pager || true
    echo ""
    echo "Test: curl -I https://bubblebim.ciuntucbimstudio.ro/"
  else
    echo "✗ Serviciul nu a pornit:"
    journalctl -u "${SERVICE_NAME}" -n 30 --no-pager
    exit 1
  fi
}

if [[ "${REMOTE}" -eq 1 ]]; then
  echo "→ Instalez cloudflared pe ${SERVER}..."
  ssh "${SERVER}" "TOKEN='${TOKEN}' bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail
TOKEN="${TOKEN}"
SERVICE_NAME="cloudflared-bubblebim"
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  . /etc/os-release
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared ${VERSION_CODENAME:-jammy} main" \
    | tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  apt-get update -qq
  apt-get install -y cloudflared
fi
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=cloudflared — tunel BubbleBIM (bubblebim.ciuntucbimstudio.ro)
After=network-online.target
Wants=network-online.target

[Service]
TimeoutStartSec=15
Type=notify
ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token ${TOKEN}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl restart ${SERVICE_NAME}
sleep 3
systemctl is-active --quiet ${SERVICE_NAME} && echo "✓ cloudflared-bubblebim activ" || { journalctl -u ${SERVICE_NAME} -n 30 --no-pager; exit 1; }
REMOTE_SCRIPT
else
  install_local
fi
