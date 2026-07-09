package com.oso.securechat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

public class KeepAliveService extends Service {
  public static final String CHANNEL_ID = "securechat_running";

  @Override
  public void onCreate() {
    super.onCreate();
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel channel = new NotificationChannel(
          CHANNEL_ID, "SecureChat активен", NotificationManager.IMPORTANCE_LOW);
      NotificationManager nm = getSystemService(NotificationManager.class);
      if (nm != null) nm.createNotificationChannel(channel);
    }
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle("SecureChat")
        .setContentText("Работает в фоне — звонки и сообщения приходят")
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setOngoing(true)
        .build();
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    } else {
      startForeground(1, notification);
    }
    return START_STICKY;
  }

  @Override
  public IBinder onBind(Intent intent) { return null; }
}
