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

# ─── Туннель: при каждом (пере)подключении ловим новую ссылку и шлём её на GitHub ───
(
  while true; do
    : > "$TUNNEL_LOG"
    ssh -tt -R 80:localhost:3000 nokey@localhost.run >> "$TUNNEL_LOG" 2>&1 &
    SSH_PID=$!

    # Ждём появления ссылки в логе (до 30 секунд)
    for i in $(seq 1 30); do
      URL=$(grep -oE 'https://[a-z0-9]+\.lhr\.life' "$TUNNEL_LOG" | head -n1)
      if [ -n "$URL" ]; then
        echo "Новая ссылка: $URL" >> "$LOG"
        bash "$APPDIR/patches/update-server-url.sh" "$URL" >> "$LOG" 2>&1
        break
      fi
      sleep 1
    done

    wait $SSH_PID
    echo "туннель оборвался, переподключение через 5 сек (ссылка сменится)..." >> "$LOG"
    sleep 5
  done
) &

echo "Сервер и туннель запущены в фоне" >> "$LOG"
