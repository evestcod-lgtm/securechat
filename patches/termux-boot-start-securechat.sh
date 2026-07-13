#!/data/data/com.termux/files/usr/bin/bash
# Автозапуск SecureChat при включении/перезагрузке телефона.
# Кладётся в ~/.termux/boot/start-securechat.sh (Termux:Boot запускает
# все скрипты из этой папки автоматически при загрузке Android).

termux-wake-lock

APPDIR="$HOME/securechat"
LOG="$APPDIR/autostart.log"
TUNNEL_LOG="$APPDIR/tunnel.log"
echo "=== Автозапуск $(date) ===" >> "$LOG"

cd "$APPDIR" || exit 1

# ─── Сервер: если упадёт — перезапускаем сам, бесконечно ───
(
  while true; do
    node server.js >> "$LOG" 2>&1
    echo "server.js упал, перезапуск через 5 сек..." >> "$LOG"
    sleep 5
  done
) &

sleep 3

# ─── Cloudflare-туннель: перезапускаем и при падении процесса, и при
# зависании с ошибками/retrying (когда процесс жив, но ссылка не работает) ───
catch_and_push_url_boot() {
  local url=""
  for i in $(seq 1 40); do
    url=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | tail -n1)
    if [ -n "$url" ]; then
      echo "Новая ссылка: $url" >> "$LOG"
      bash "$APPDIR/patches/update-server-url.sh" "$url" >> "$LOG" 2>&1
      echo "$url" > "$APPDIR/.current_tunnel_url"
      return 0
    fi
    sleep 1
  done
  echo "⚠️ Ссылка не появилась за 40 секунд" >> "$LOG"
  return 1
}

is_url_healthy_boot() {
  local url="$1"
  [ -z "$url" ] && return 1
  curl -sf -o /dev/null -m 10 "$url" 2>/dev/null
  local code=$?
  if [ $code -eq 0 ] || [ $code -eq 22 ]; then return 0; fi
  return 1
}

(
  while true; do
    : > "$TUNNEL_LOG"
    cloudflared tunnel --url http://localhost:3000 >> "$TUNNEL_LOG" 2>&1 &
    CF_PID=$!

    catch_and_push_url_boot
    CURRENT_URL=$(cat "$APPDIR/.current_tunnel_url" 2>/dev/null)

    while kill -0 "$CF_PID" 2>/dev/null; do
      sleep 45
      if ! kill -0 "$CF_PID" 2>/dev/null; then break; fi
      if ! is_url_healthy_boot "$CURRENT_URL"; then
        echo "⚠️ Туннель не отвечает (ошибки/retrying) — перезапуск" >> "$LOG"
        kill "$CF_PID" 2>/dev/null
        sleep 2
        kill -9 "$CF_PID" 2>/dev/null
        break
      fi
    done

    echo "туннель оборвался/завис, переподключение через 5 сек (ссылка сменится)..." >> "$LOG"
    sleep 5
  done
) &

echo "Сервер и туннель запущены в фоне" >> "$LOG"
