package br.gbs.busca;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;

/** Aviso de mensagem dos bombeiros com o aplicativo em segundo plano (a página pede; som e vibração do sistema). */
final class Avisos {
  private static final String CANAL = "mensagens";
  private static final int ID = 8;

  private Avisos() { }

  static void mensagem(Context c, String titulo, String texto) {
    NotificationManager nm = c.getSystemService(NotificationManager.class);
    if (nm == null) return;
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel ch = new NotificationChannel(CANAL, c.getString(R.string.canal_mensagens), NotificationManager.IMPORTANCE_HIGH);
      ch.enableVibration(true);
      ch.setVibrationPattern(new long[] { 0, 400, 150, 400, 150, 800 });
      nm.createNotificationChannel(ch);
    }
    Intent abrir = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    PendingIntent pi = PendingIntent.getActivity(c, 1, abrir, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    NotificationCompat.Builder b = new NotificationCompat.Builder(c, CANAL)
        .setSmallIcon(R.drawable.ic_notificacao)
        .setContentTitle(titulo == null || titulo.isEmpty() ? c.getString(R.string.app_name) : titulo)
        .setContentText(texto)
        .setStyle(new NotificationCompat.BigTextStyle().bigText(texto))
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .setAutoCancel(true)
        .setVibrate(new long[] { 0, 400, 150, 400, 150, 800 })
        .setContentIntent(pi);
    try { nm.notify(ID, b.build()); } catch (Exception e) { /* sem permissão de avisos */ }
  }
}
