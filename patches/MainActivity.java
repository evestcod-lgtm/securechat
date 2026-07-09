package com.oso.securechat;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
  private static final int PERM_REQ = 1001;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // Разрешаем WebView отдавать камеру/микрофон странице (getUserMedia),
    // как только Android выдал системное разрешение CAMERA/RECORD_AUDIO ниже.
    this.bridge.getWebView().setWebChromeClient(new WebChromeClient() {
      @Override
      public void onPermissionRequest(final PermissionRequest request) {
        runOnUiThread(() -> request.grant(request.getResources()));
      }
    });

    List<String> toAsk = new ArrayList<>();
    String[] perms = { Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO, Manifest.permission.VIBRATE };
    for (String p : perms) {
      if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) toAsk.add(p);
    }
    if (android.os.Build.VERSION.SDK_INT >= 33
        && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      toAsk.add(Manifest.permission.POST_NOTIFICATIONS);
    }
    if (!toAsk.isEmpty()) {
      ActivityCompat.requestPermissions(this, toAsk.toArray(new String[0]), PERM_REQ);
    }

    // Фоновый сервис — держит процесс живым, чтобы сокет не рвался, когда экран выключен
    startService(new android.content.Intent(this, KeepAliveService.class));
  }
}
