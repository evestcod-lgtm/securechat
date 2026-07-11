#!/data/data/com.termux/files/usr/bin/bash
# Запускает только сервер (в фоне). Туннель — отдельным скриптом start-tunnel.sh
# в ДРУГОЙ сессии Termux (localhost.run обрывает соединения, запущенные в фоне
# через nohup — туннель обязательно должен работать в открытой интерактивной сессии).

cd "$(dirname "$0")"
termux-wake-lock 2>/dev/null

echo "🔐 Запуск SecureChat сервера..."
nohup node server.js > server.log 2>&1 &
echo "Сервер запущен (PID $!). Логи: $(pwd)/server.log"
echo ""
echo "Дальше открой НОВУЮ сессию Termux (свайп слева → New session)"
echo "и в ней выполни: ./start-tunnel.sh"
