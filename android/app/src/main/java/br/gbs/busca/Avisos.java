package br.gbs.busca;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.text.TextUtils;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Mensagens dos bombeiros na barra de notificações, como num aplicativo de conversa: som, vibração, aparece por cima
 * dos outros aplicativos e na tela bloqueada. Vem do serviço de GPS (app fechado ou tela apagada, migração 056) ou
 * da página (app em segundo plano). Cada mensagem avisa uma vez só, venha de onde vier (ids guardados no aparelho).
 */
final class Avisos {
  private static final String CANAL = "mensagens_bombeiros";
  private static final String CANAL_ANTIGO = "mensagens";
  private static final int ID = 8;
  private static final int MAX_LINHAS = 8;
  private static final int MAX_IDS = 200;
  private static final long[] VIBRACAO = { 0, 400, 150, 400, 150, 800 };
  private static final ArrayDeque<String[]> linhas = new ArrayDeque<>();   // { texto, quando(ms) } da conversa aberta

  private Avisos() { }

  /** Título curto de cada tipo de mensagem (o mesmo do comunicacao.js). */
  static String titulo(String tipo) {
    if (tipo == null) return "Mensagem";
    switch (tipo) {
      case "RETORNE": return "RETORNE";
      case "ATENCAO": return "ATENÇÃO — CUIDADO";
      case "MUDE_ROTA": return "MUDE A ROTA";
      case "PARE": return "PARE";
      case "CONFIRME": return "CONFIRME SUA SITUAÇÃO";
      default: return "Mensagem";
    }
  }

  /** Texto do comando quando os bombeiros não escreveram nada (o mesmo do comunicacao.js). */
  static String padrao(String tipo) {
    if (tipo == null) return "";
    switch (tipo) {
      case "RETORNE": return "Retorne ao ponto de apoio ou ao local indicado.";
      case "ATENCAO": return "Condição de risco na sua área. Redobre a atenção.";
      case "MUDE_ROTA": return "Mude a direção conforme orientação do responsável.";
      case "PARE": return "Interrompa o deslocamento e aguarde instruções.";
      case "CONFIRME": return "Confirme o recebimento e informe sua situação.";
      default: return "";
    }
  }

  /** Linha da notificação: "RETORNE: texto" para comandos, só o texto para mensagem livre. */
  static String linha(String tipo, String texto) {
    String t = texto == null ? "" : texto.trim();
    if (t.isEmpty()) t = padrao(tipo);
    if (tipo == null || "PERSONALIZADA".equals(tipo)) return t.isEmpty() ? "Nova mensagem" : t;
    return t.isEmpty() ? titulo(tipo) : titulo(tipo) + ": " + t;
  }

  private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("gbs-avisos", Context.MODE_PRIVATE); }

  static synchronized boolean jaAvisada(Context c, String id) {
    if (id == null || id.isEmpty()) return false;
    return Arrays.asList(prefs(c).getString("ids", "").split(",")).contains(id);
  }

  /** Guarda o id como já avisado (a tela estava aberta e a própria página mostrou a mensagem). */
  static synchronized void marcar(Context c, String id) {
    if (id == null || id.isEmpty() || jaAvisada(c, id)) return;
    List<String> ids = new ArrayList<>(Arrays.asList(prefs(c).getString("ids", "").split(",")));
    ids.remove("");
    ids.add(id);
    while (ids.size() > MAX_IDS) ids.remove(0);
    prefs(c).edit().putString("ids", TextUtils.join(",", ids)).apply();   // String.join só existe a partir do Android 8
  }

  private static void criarCanal(Context c, NotificationManager nm) {
    if (Build.VERSION.SDK_INT < 26) return;
    if (nm.getNotificationChannel(CANAL_ANTIGO) != null) nm.deleteNotificationChannel(CANAL_ANTIGO);   // sem som próprio
    if (nm.getNotificationChannel(CANAL) != null) return;
    NotificationChannel ch = new NotificationChannel(CANAL, c.getString(R.string.canal_mensagens), NotificationManager.IMPORTANCE_HIGH);
    ch.setDescription(c.getString(R.string.canal_mensagens_desc));
    ch.enableVibration(true);
    ch.setVibrationPattern(VIBRACAO);
    ch.enableLights(true);
    ch.setLightColor(Color.RED);
    ch.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
    ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
    nm.createNotificationChannel(ch);
  }

  /** Avisa uma mensagem (id null = sem controle de repetição). Junta as mensagens numa conversa "Bombeiros". */
  static synchronized void mensagem(Context c, String id, String titulo, String texto, long quandoMs) {
    if (jaAvisada(c, id)) return;
    marcar(c, id);
    NotificationManager nm = c.getSystemService(NotificationManager.class);
    if (nm == null) return;
    criarCanal(c, nm);
    String linha = texto == null || texto.trim().isEmpty() ? (titulo == null || titulo.isEmpty() ? "Nova mensagem" : titulo) : texto.trim();
    long quando = quandoMs > 0 ? quandoMs : System.currentTimeMillis();
    linhas.addLast(new String[] { linha, String.valueOf(quando) });
    while (linhas.size() > MAX_LINHAS) linhas.removeFirst();

    Person bombeiros = new Person.Builder().setName("Bombeiros").setImportant(true).build();
    NotificationCompat.MessagingStyle estilo = new NotificationCompat.MessagingStyle(new Person.Builder().setName("Você").build())
        .setConversationTitle(c.getString(R.string.notif_msgs_titulo));
    for (String[] l : linhas) estilo.addMessage(l[0], Long.parseLong(l[1]), bombeiros);

    Intent abrir = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    PendingIntent pi = PendingIntent.getActivity(c, 1, abrir, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    NotificationCompat.Builder b = new NotificationCompat.Builder(c, CANAL)
        .setSmallIcon(R.drawable.ic_notificacao)
        .setColor(Color.rgb(220, 38, 38))
        .setContentTitle(c.getString(R.string.notif_msgs_titulo))
        .setContentText(linha)
        .setStyle(estilo)
        .setNumber(linhas.size())
        .setWhen(quando)
        .setShowWhen(true)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))   // Android 7 (sem canais)
        .setVibrate(VIBRACAO)
        .setLights(Color.RED, 800, 1200)
        .setOnlyAlertOnce(false)
        .setAutoCancel(true)
        .setContentIntent(pi)
        .addAction(0, c.getString(R.string.notif_msgs_abrir), pi);
    try { nm.notify(ID, b.build()); } catch (Exception e) { /* sem permissão de avisos */ }
  }

  /** O aplicativo foi aberto: a página mostra as mensagens; a conversa da barra sai. */
  static synchronized void limpar(Context c) {
    linhas.clear();
    NotificationManager nm = c.getSystemService(NotificationManager.class);
    if (nm != null) nm.cancel(ID);
  }
}
