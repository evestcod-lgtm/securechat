#!/data/data/com.termux/files/usr/bin/bash
# Обновляет patches/current-server-url.txt в твоём GitHub-репозитории
# на актуальную ссылку туннеля — чтобы APK всегда сам знал, куда стучаться,
# без пересборки и без ручного ввода.
#
# Использование: ./update-server-url.sh "https://новая-ссылка.lhr.life"
#
# Требует в ~/securechat/.env:
#   GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx   (Personal Access Token, права: repo)
#   GITHUB_REPO=evestcod-lgtm/securechat
#   GITHUB_BRANCH=main

set -e
cd "$(dirname "$0")/.."   # ~/securechat
source .env 2>/dev/null || true

NEW_URL="$1"
if [ -z "$NEW_URL" ]; then
  echo "Использование: $0 https://новая-ссылка"
  exit 1
fi
if [ -z "$GITHUB_TOKEN" ] || [ -z "$GITHUB_REPO" ]; then
  echo "⚠️ GITHUB_TOKEN или GITHUB_REPO не заданы в .env — пропускаю обновление на GitHub"
  exit 0
fi

BRANCH="${GITHUB_BRANCH:-main}"
FILE_PATH="patches/current-server-url.txt"
API="https://api.github.com/repos/$GITHUB_REPO/contents/$FILE_PATH"

# 1. Узнаём текущий sha файла (нужен для обновления существующего файла)
CURRENT=$(curl -s -H "Authorization: token $GITHUB_TOKEN" "$API?ref=$BRANCH")
SHA=$(echo "$CURRENT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{ try{ console.log(JSON.parse(d).sha || ''); }catch(e){ console.log(''); } });
")

# 2. Кодируем новое содержимое файла в base64
CONTENT_B64=$(printf '%s\n' "$NEW_URL" | base64 -w0)

# 3. Отправляем обновление
BODY=$(node -e "
  console.log(JSON.stringify({
    message: 'auto: обновление адреса сервера',
    content: '$CONTENT_B64',
    branch: '$BRANCH',
    sha: '$SHA' || undefined
  }));
")

curl -s -X PUT "$API" \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY" > /tmp/gh-update-response.json

if grep -q '"content"' /tmp/gh-update-response.json; then
  echo "✅ Адрес сервера обновлён на GitHub: $NEW_URL"
else
  echo "⚠️ Не удалось обновить файл на GitHub, ответ:"
  cat /tmp/gh-update-response.json
fi
