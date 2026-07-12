#!/bin/bash
# Патчит сгенерированный `npx cap add android` проект:
# - добавляет разрешения в AndroidManifest.xml
# - добавляет объявление foreground-сервиса
# - кладёт MainActivity.java и KeepAliveService.java с нашей логикой
set -e

APP_ID="com.oso.securechat"
PKG_PATH=$(echo "$APP_ID" | tr '.' '/')
JAVA_DIR="android/app/src/main/java/$PKG_PATH"
MANIFEST="android/app/src/main/AndroidManifest.xml"

echo "→ Патчим $MANIFEST"

# 1. Вставляем разрешения перед <application
if ! grep -q "FOREGROUND_SERVICE_DATA_SYNC" "$MANIFEST"; then
  PERMS=$(cat patches/manifest-permissions.xml)
  # python используется просто как надёжный текстовый инструмент (есть в GH Actions runner по умолчанию)
  python3 - "$MANIFEST" "$PERMS" <<'PYEOF'
import sys
manifest_path = sys.argv[1]
perms = sys.argv[2]
with open(manifest_path, 'r', encoding='utf-8') as f:
    content = f.read()
content = content.replace('<application', perms + '\n    <application', 1)
with open(manifest_path, 'w', encoding='utf-8') as f:
    f.write(content)
PYEOF
fi

# 2. Регистрируем KeepAliveService внутри <application>...</application>
if ! grep -q "KeepAliveService" "$MANIFEST"; then
  python3 - "$MANIFEST" <<'PYEOF'
import sys
manifest_path = sys.argv[1]
with open(manifest_path, 'r', encoding='utf-8') as f:
    content = f.read()
service_tag = '        <service android:name=".KeepAliveService" android:foregroundServiceType="dataSync" android:exported="false" />\n    </application>'
content = content.replace('    </application>', service_tag, 1)
with open(manifest_path, 'w', encoding='utf-8') as f:
    f.write(content)
PYEOF
fi

# 3. Кладём наши Java-файлы
mkdir -p "$JAVA_DIR"
cp patches/MainActivity.java "$JAVA_DIR/MainActivity.java"
cp patches/KeepAliveService.java "$JAVA_DIR/KeepAliveService.java"
cp patches/CallPlugin.java "$JAVA_DIR/CallPlugin.java"

echo "✅ Android-проект пропатчен (permissions + KeepAliveService + MainActivity)"
