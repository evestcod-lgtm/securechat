#!/data/data/com.termux/files/usr/bin/bash
# Запускает Cloudflare-туннель в фоне под супервизором, который держит его
# живым всегда:
#  1) если процесс cloudflared упадёт целиком — перезапускает его;
#  2) если процесс жив, но пишет ошибки/"retrying" и реальная ссылка не
#     отвечает — тоже перезапускает (просто "живой процесс" не значит
#     "рабочий туннель").
# Каждый раз при перезапуске сам ловит новую ссылку и отправляет на GitHub.
# Можно закрывать сессию Termux после запуска.

cd "$(dirname "$0")"
termux-wake-lock 2>/dev/null

APPDIR="$(pwd)"
TUNNEL_LOG="$APPDIR/tunnel.log"
LOG="$APPDIR/autostart.log"

echo "=== start-tunnel.sh запущен $(date) ===" >> "$LOG"

# Убиваем возможные старые супервизоры/cloudflared, чтобы не плодить дубликаты
pkill -f "SECURECHAT_TUNNEL_WATCHDOG" 2>/dev/null
pkill -f cloudflared 2>/dev/null
sleep 1

watchdog_body='
APPDIR="'"$APPDIR"'"
TUNNEL_LOG="'"$TUNNEL_LOG"'"
LOG="'"$LOG"'"
cd "$APPDIR"

catch_and_push_url() {
  local url=""
  for i in $(seq 1 40); do
    url=$(grep -oE "https://[a-zA-Z0-9-]+\.trycloudflare\.com" "$TUNNEL_LOG" | tail -n1)
    if [ -n "$url" ]; then
      echo "" >> "$LOG"
      echo "✅ Новый адрес сервера: $url" >> "$LOG"
      bash "$APPDIR/patches/update-server-url.sh" "$url" >> "$LOG" 2>&1
      echo "$url" > "$APPDIR/.current_tunnel_url"
      return 0
    fi
    sleep 1
  done
  echo "⚠️ Ссылка не появилась за 40 секунд" >> "$LOG"
  return 1
}

is_url_healthy() {
  local url="$1"
  [ -z "$url" ] && return 1
  curl -sf -o /dev/null -m 10 "$url" 2>/dev/null
  local code=$?
  # 000/несоединение = плохо; любой HTTP-ответ (даже 404/502 от самого cloudflare) считаем что туннель хотя бы жив
  if [ $code -eq 0 ] || [ $code -eq 22 ]; then return 0; fi
  return 1
}

while true; do
  : > "$TUNNEL_LOG"
  # SECURECHAT_TUNNEL_WATCHDOG — метка в командной строке, чтобы можно было найти и убить процесс через pkill -f
  SECURECHAT_TUNNEL_WATCHDOG=1 cloudflared tunnel --url http://localhost:3000 >> "$TUNNEL_LOG" 2>&1 &
  CF_PID=$!
  echo "cloudflared запущен, PID $CF_PID" >> "$LOG"

  catch_and_push_url
  CURRENT_URL=$(cat "$APPDIR/.current_tunnel_url" 2>/dev/null)

  # Пока процесс жив — раз в 45 секунд проверяем, что ссылка реально отвечает.
  # Если процесс упал ИЛИ перестал отвечать/пишет ошибки без восстановления —
  # убиваем и запускаем заново.
  while kill -0 "$CF_PID" 2>/dev/null; do
    sleep 45
    if ! kill -0 "$CF_PID" 2>/dev/null; then break; fi
    if ! is_url_healthy "$CURRENT_URL"; then
      echo "⚠️ Туннель не отвечает (или в логе ошибки/retrying) — перезапуск" >> "$LOG"
      kill "$CF_PID" 2>/dev/null
      sleep 2
      kill -9 "$CF_PID" 2>/dev/null
      break
    fi
  done

  echo "⚠️ cloudflared перезапускается (упал/ошибка/обрыв) — через 5 сек..." >> "$LOG"
  sleep 5
done
'

nohup bash -c "$watchdog_body" > "$LOG" 2>&1 &
WATCHDOG_PID=$!
echo "Супервизор-туннель запущен (PID $WATCHDOG_PID)."
echo "Сам следит за cloudflared: перезапускает при падении процесса И при ошибках/retrying, если ссылка перестала отвечать."

sleep 3
for i in $(seq 1 20); do
  URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -n1)
  if [ -n "$URL" ]; then
    echo ""
    echo "✅ Твой адрес сервера: $URL"
    break
  fi
  sleep 1
done

echo ""
echo "Туннель работает в фоне под супервизором — можно закрывать эту сессию Termux."
echo "Логи: $LOG и $TUNNEL_LOG"
echo ""
echo "Если нужно остановить туннель полностью:"
echo "  pkill -f SECURECHAT_TUNNEL_WATCHDOG; pkill -f cloudflared"
