package com.oso.securechat;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
  private static final int PERM_REQ = 1001;
  private static final int FILE_CHOOSER_REQ = 2001;
  private ValueCallback<Uri[]> filePathCallback;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // Регистрируем плагин полноэкранного звонка (см. CallPlugin.java)
    registerPlugin(CallPlugin.class);

    // Если это открытие по входящему звонку — показываем поверх заблокированного экрана
    handleIncomingCallIntent(getIntent());

    WebView webView = this.bridge.getWebView();
    webView.setWebChromeClient(new WebChromeClient() {
      // Разрешаем WebView отдавать камеру/микрофон странице (getUserMedia),
      // как только Android выдал системное разрешение CAMERA/RECORD_AUDIO ниже.
      @Override
      public void onPermissionRequest(final PermissionRequest request) {
        runOnUiThread(() -> request.grant(request.getResources()));
      }

      // Без этого метода <input type="file"> в WebView НИЧЕГО не делает при нажатии —
      // это и есть причина, почему кнопки "выбрать аватарку/рингтон/звук" не работали.
      @Override
      public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (filePathCallback != null) {
          filePathCallback.onReceiveValue(null);
        }
        filePathCallback = callback;
        Intent intent = params.createIntent();
        try {
          startActivityForResult(intent, FILE_CHOOSER_REQ);
        } catch (Exception e) {
          filePathCallback = null;
          return false;
        }
        return true;
      }
    });

    List<String> toAsk = new ArrayList<>();
    String[] perms = { Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO, Manifest.permission.VIBRATE };
    for (String p : perms) {
      if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) toAsk.add(p);
    }
    if (Build.VERSION.SDK_INT >= 33
        && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      toAsk.add(Manifest.permission.POST_NOTIFICATIONS);
    }
    if (!toAsk.isEmpty()) {
      ActivityCompat.requestPermissions(this, toAsk.toArray(new String[0]), PERM_REQ);
    }

    // Фоновый сервис — держит процесс живым, чтобы сокет не рвался, когда экран выключен
    startService(new Intent(this, KeepAliveService.class));
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    handleIncomingCallIntent(intent);
  }

  private void handleIncomingCallIntent(Intent intent) {
    if (intent != null && intent.getBooleanExtra("incoming_call", false)) {
      // Показываем приложение поверх заблокированного экрана и включаем экран —
      // именно так работает полноэкранный вызов, как у обычного телефонного звонка.
      if (Build.VERSION.SDK_INT >= 27) {
        setShowWhenLocked(true);
        setTurnScreenOn(true);
      } else {
        getWindow().addFlags(
          WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
          | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
          | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
        );
      }
      getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == FILE_CHOOSER_REQ) {
      if (filePathCallback == null) { super.onActivityResult(requestCode, resultCode, data); return; }
      Uri[] results = null;
      if (resultCode == RESULT_OK && data != null) {
        String dataString = data.getDataString();
        if (dataString != null) {
          results = new Uri[]{ Uri.parse(dataString) };
        } else if (data.getClipData() != null) {
          int count = data.getClipData().getItemCount();
          results = new Uri[count];
          for (int i = 0; i < count; i++) {
            results[i] = data.getClipData().getItemAt(i).getUri();
          }
        }
      }
      filePathCallback.onReceiveValue(results);
      filePathCallback = null;
      return;
    }
    super.onActivityResult(requestCode, resultCode, data);
  }
}
