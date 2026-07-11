#!/data/data/com.termux/files/usr/bin/bash
# Запуск SecureChat в Termux. Сервер и туннель — в отдельных фоновых процессах,
# как при ручном запуске в двух сессиях (это оказалось стабильнее).
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

cd "$(dirname "$0")"
termux-wake-lock 2>/dev/null

APPDIR="$(pwd)"
TUNNEL_LOG="$APPDIR/tunnel.log"

echo "🔐 Запуск SecureChat сервера..."
nohup node server.js > "$APPDIR/server.log" 2>&1 &
SERVER_PID=$!
sleep 2

echo "🌐 Открываю туннель (localhost.run)..."
: > "$TUNNEL_LOG"
nohup ssh -R 80:localhost:3000 nokey@localhost.run > "$TUNNEL_LOG" 2>&1 &
SSH_PID=$!

# Ждём появления ссылки в логе (до 30 секунд)
URL=""
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9]+\.lhr\.life' "$TUNNEL_LOG" | head -n1)
  if [ -n "$URL" ]; then
    break
  fi
  sleep 1
done

if [ -n "$URL" ]; then
  echo ""
  echo "✅ Твой адрес сервера: $URL"
  bash "$APPDIR/patches/update-server-url.sh" "$URL"
else
  echo ""
  echo "⚠️ Ссылка пока не появилась, проверь вручную: cat $TUNNEL_LOG"
fi

echo ""
echo "Сервер (PID $SERVER_PID) и туннель (PID $SSH_PID) работают в фоне."
echo "Можно закрывать сессию Termux — процессы продолжат работать (nohup)."
echo "Логи: $APPDIR/server.log и $TUNNEL_LOG"
