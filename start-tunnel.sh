#!/data/data/com.termux/files/usr/bin/bash
# Запускает туннель localhost.run напрямую, без обёрток (nohup/script/tee
# ломают соединение — localhost.run обрывает его, если видит, что ssh
# запущен не в "голой" интерактивной сессии). Поэтому просто держим эту
# сессию Termux открытой.
#
# После того как увидишь строку с адресом (https://xxxx.lhr.life),
# скопируй её и выполни в ДРУГОЙ сессии:
#   bash patches/update-server-url.sh "https://xxxx.lhr.life"

cd "$(dirname "$0")"
termux-wake-lock 2>/dev/null

echo "🌐 Открываю туннель (localhost.run)... не закрывай эту сессию"
echo "Когда увидишь ссылку https://xxxx.lhr.life — скопируй её и в другой"
echo "сессии выполни: bash patches/update-server-url.sh \"ссылка\""
echo ""
ssh -R 80:localhost:3000 nokey@localhost.run
