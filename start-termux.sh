#!/data/data/com.termux/files/usr/bin/bash
# Ручной запуск SecureChat в Termux (используй это сейчас, для теста —
# после настройки Termux:Boot сервер будет включаться сам при перезагрузке,
# см. README-BUILD.md раздел "Автозапуск").
#
# Первый раз перед запуском:
#   pkg update && pkg upgrade -y
#   pkg install nodejs git openssh -y
#   npm install
#   cp .env.example .env   # затем отредактируй .env (nano .env)
#
# Чтобы Termux не засыпал и не убивал процесс:
#   termux-wake-lock
#   (плюс в настройках Android — отключи "оптимизацию батареи" для Termux)

set -e
cd "$(dirname "$0")"
termux-wake-lock 2>/dev/null

APPDIR="$(pwd)"
TUNNEL_LOG="$APPDIR/tunnel.log"

echo "🔐 Запуск SecureChat сервера..."
node server.js &
SERVER_PID=$!
sleep 2

echo "🌐 Открываю туннель (localhost.run)..."
: > "$TUNNEL_LOG"
ssh -R 80:localhost:3000 nokey@localhost.run 2>&1 | tee -a "$TUNNEL_LOG" &
SSH_PID=$!

# Ждём ссылку и сразу пушим её на GitHub
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9]+\.lhr\.life' "$TUNNEL_LOG" | head -n1)
  if [ -n "$URL" ]; then
    echo ""
    echo "✅ Твой адрес сервера: $URL"
    bash "$APPDIR/patches/update-server-url.sh" "$URL"
    break
  fi
  sleep 1
done

echo ""
echo "Сервер и туннель работают. Не закрывай Termux."
wait $SERVER_PID $SSH_PID
