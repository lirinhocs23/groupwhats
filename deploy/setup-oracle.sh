#!/bin/bash
# Instalação inicial do GroupWhats na Oracle Cloud (Ubuntu 22/24 ARM).
# Uso na VM: curl -sL ... | bash   OU   chmod +x deploy/setup-oracle.sh && ./deploy/setup-oracle.sh
#
# Pré-requisitos Oracle Console:
# - VM Ampere A1 (Ubuntu Minimal aarch64)
# - Security List: liberar TCP 3000 (ou 80/443 se usar nginx depois)
# - Chave SSH configurada

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/lirinhocs23/groupwhats.git}"
APP_DIR="${APP_DIR:-/home/ubuntu/groupwhats}"
DATA_DIR="${DATA_DIR:-/data/groupwhats}"

echo "=== GroupWhats — setup Oracle Cloud ==="

if [ "$(id -u)" -ne 0 ]; then
  echo "Execute com sudo: sudo bash deploy/setup-oracle.sh"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  git curl ca-certificates \
  chromium ffmpeg \
  fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
  --no-install-recommends

# Node.js 20 LTS
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

npm install -g pm2

mkdir -p "$DATA_DIR/wwebjs_auth" "$DATA_DIR/db" "$DATA_DIR/relatorios"
chown -R ubuntu:ubuntu "$DATA_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
  sudo -u ubuntu git clone "$REPO_URL" "$APP_DIR"
else
  echo "Repositório já existe em $APP_DIR — pulando clone."
fi

cd "$APP_DIR"
sudo -u ubuntu npm install

if [ ! -f "$APP_DIR/.env" ]; then
  sudo -u ubuntu cp .env.example .env
  echo ""
  echo ">>> Edite o .env antes de subir o bot:"
  echo "    nano $APP_DIR/.env"
  echo "    (GEMINI_API_KEY, caminhos WWEBJS_AUTH_PATH e DATABASE_PATH)"
fi

# PM2 como usuário ubuntu
sudo -u ubuntu bash -c "cd '$APP_DIR' && pm2 delete groupwhats 2>/dev/null || true"
sudo -u ubuntu bash -c "cd '$APP_DIR' && pm2 start server.js --name groupwhats --time"
sudo -u ubuntu pm2 save
env PATH="$PATH:/usr/bin" pm2 startup systemd -u ubuntu --hp /home/ubuntu | tail -1 | bash || true

# Firewall local (Oracle também exige regra na Security List)
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH || true
  ufw allow 3000/tcp || true
fi

PUBLIC_IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || echo "SEU_IP_PUBLICO")

echo ""
echo "=== Instalação concluída ==="
echo "Painel: http://${PUBLIC_IP}:3000"
echo "Logs:   sudo -u ubuntu pm2 logs groupwhats"
echo "Status: sudo -u ubuntu pm2 status"
echo ""
echo "Oracle Console → VCN → Security List → Ingress: TCP 3000 de 0.0.0.0/0"
echo "Atualizar código depois: cd $APP_DIR && ./update.sh"
