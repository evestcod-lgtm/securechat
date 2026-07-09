#!/data/data/com.termux/files/usr/bin/bash
# Запуск SecureChat сервера в Termux.
# Первый раз перед запуском:
#   pkg update && pkg upgrade -y
#   pkg install nodejs git -y
#   termux-setup-storage
#   npm install
#   cp .env.example .env   # затем отредактируй .env (nano .env)
#
# Чтобы Termux не засыпал и не убивал процесс:
#   termux-wake-lock
#   (плюс в настройках Android — отключи "оптимизацию батареи" для Termux)
#
# Для доступа не только по локальному Wi-Fi — установи Tailscale (см. README-BUILD.md)

cd "$(dirname "$0")"
termux-wake-lock 2>/dev/null

echo "🔐 Запуск SecureChat сервера..."
node server.js
