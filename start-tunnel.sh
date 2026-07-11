#!/data/data/com.termux/files/usr/bin/bash
# Запускает туннель localhost.run В ЭТОЙ ЖЕ сессии (не в фоне — это важно,
# в фоне через nohup localhost.run обрывает соединение сразу).
# Параллельно небольшой фоновый "ловец" следит за появлением ссылки в логе
# и как только видит её — сам отправляет на GitHub (patches/update-server-url.sh).
#
# Держи эту сессию Termux открытой всё время, пока хочешь, чтобы сервер был
# доступен снаружи. Если закроешь — просто открой новую и запусти ./start-tunnel.sh
# заново (ссылка будет новая, но она автоматически обновится на GitHub).

cd "$(dirname "$0")"
termux-wake-lock 2>/dev/null

TUNNEL_LOG="$(pwd)/tunnel.log"
: > "$TUNNEL_LOG"

# Фоновый "ловец" ссылки — следит за логом, пока туннель работает в этой сессии
(
  for i in $(seq 1 60); do
    URL=$(grep -oE 'https://[a-z0-9]+\.lhr\.life' "$TUNNEL_LOG" | head -n1)
    if [ -n "$URL" ]; then
      echo ""
      echo "✅ Твой адрес сервера: $URL"
      bash "$(pwd)/patches/update-server-url.sh" "$URL"
      break
    fi
    sleep 1
  done
) &

echo "🌐 Открываю туннель (localhost.run)... не закрывай эту сессию"
ssh -R 80:localhost:3000 nokey@localhost.run 2>&1 | tee "$TUNNEL_LOG"
