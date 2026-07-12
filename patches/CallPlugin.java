package com.oso.securechat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CallPlugin")
public class CallPlugin extends Plugin {
  public static final String CHANNEL_ID = "securechat_incoming_call";
  public static final int NOTIF_ID = 9911;

  @PluginMethod
  public void showFullScreenCall(PluginCall call) {
    String name = call.getString("name", "Входящий звонок");
    String type = call.getString("type", "audio");
    Context ctx = getContext();

    Intent fullScreenIntent = new Intent(ctx, MainActivity.class);
    fullScreenIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    fullScreenIntent.putExtra("incoming_call", true);

    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent pendingIntent = PendingIntent.getActivity(ctx, 0, fullScreenIntent, flags);

    NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Входящие звонки", NotificationManager.IMPORTANCE_HIGH);
      channel.setDescription("Полноэкранные уведомления о входящих звонках");
      channel.enableVibration(true);
      if (nm != null) nm.createNotificationChannel(channel);
    }

    Notification.Builder builder;
    if (Build.VERSION.SDK_INT >= 26) {
      builder = new Notification.Builder(ctx, CHANNEL_ID);
    } else {
      builder = new Notification.Builder(ctx);
    }

    Notification notification = builder
      .setContentTitle(name)
      .setContentText("video".equals(type) ? "Видеозвонок" : "Аудиозвонок")
      .setSmallIcon(android.R.drawable.sym_call_incoming)
      .setPriority(Notification.PRIORITY_MAX)
      .setCategory(Notification.CATEGORY_CALL)
      .setFullScreenIntent(pendingIntent, true)
      .setContentIntent(pendingIntent)
      .setAutoCancel(true)
      .build();

    if (nm != null) nm.notify(NOTIF_ID, notification);
    call.resolve();
  }

  @PluginMethod
  public void dismissCallNotification(PluginCall call) {
    NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm != null) nm.cancel(NOTIF_ID);
    call.resolve();
  }
}
