package br.gbs.busca;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Registro da trilha em segundo plano (serviço em primeiro plano do Android, com aviso fixo na barra de notificações).
 * Continua com a tela apagada, com o aplicativo minimizado ou fechado da lista de recentes.
 *   leitura do GPS → filtro (igual ao da página) → fila gravada no aparelho → envio com confirmação do servidor.
 * Sem internet, a fila cresce sem descartar nada e é enviada sozinha quando a conexão volta.
 * Duas linhas de execução: uma para o GPS e a fila (nunca espera a rede) e outra para o envio.
 */
public class RastreioService extends Service {

  static final String PARAR = "br.gbs.busca.PARAR";
  static final String EXTRA_MOTIVO = "motivo";
  private static final String CANAL = "rastreio";
  private static final int NOTIF = 7;
  private static final long SINAL_MS = 30000;
  private static final long SEM_GPS_MS = 60000;

  private HandlerThread linhaGps, linhaRede;
  private Handler gps, rede;
  private Config cfg;
  private FiltroGps filtro;
  private FilaPontos fila;
  private Sincronizador sync;
  private FonteLocalizacao fonte;
  private PowerManager.WakeLock trava;
  private ConnectivityManager.NetworkCallback aoTerRede;
  private final List<FiltroGps.Ponto> naoGravados = new ArrayList<>();
  private long envioMarcadoPara;
  private long ultimoAvisoNotif;
  private String ultimoTextoNotif = "";
  private boolean ativo;
  private String participanteAtivo;

  static void iniciar(Context c) {
    ContextCompat.startForegroundService(c, new Intent(c, RastreioService.class));
  }

  static void parar(Context c, String motivo) {
    Intent i = new Intent(c, RastreioService.class).setAction(PARAR).putExtra(EXTRA_MOTIVO, motivo);
    try {
      c.startService(i);
    } catch (Exception e) {
      // serviço já parado: só limpa o que ficou
      new Config(c).encerrar(motivo);
    }
  }

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public void onCreate() {
    super.onCreate();
    cfg = new Config(this);
    linhaGps = new HandlerThread("gbs-gps");
    linhaGps.start();
    gps = new Handler(linhaGps.getLooper());
    linhaRede = new HandlerThread("gbs-rede");
    linhaRede.start();
    rede = new Handler(linhaRede.getLooper());
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (Build.VERSION.SDK_INT >= 26 && nm != null) {
      NotificationChannel ch = new NotificationChannel(CANAL, getString(R.string.canal_rastreio), NotificationManager.IMPORTANCE_LOW);
      ch.setDescription(getString(R.string.canal_rastreio_desc));
      ch.setShowBadge(false);
      nm.createNotificationChannel(ch);
    }
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && PARAR.equals(intent.getAction())) {
      // precisa entrar em primeiro plano mesmo para parar (pedido feito com startForegroundService em alguns casos)
      if (!ativo) { cfg.encerrar(intent.getStringExtra(EXTRA_MOTIVO)); stopSelf(); return START_NOT_STICKY; }
      String m = intent.getStringExtra(EXTRA_MOTIVO);
      gps.post(() -> encerrar(m, false));
      return START_NOT_STICKY;
    }
    if (!cfg.rastreando() || !cfg.prontoParaRastrear() || !FonteLocalizacao.temPermissao(this)) {
      Estado.I.ultimoErro = FonteLocalizacao.temPermissao(this) ? "sem_configuracao" : "negado";
      pararServico();
      return START_NOT_STICKY;
    }
    try {
      if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF, notificacao(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
      else startForeground(NOTIF, notificacao());
    } catch (Exception e) {
      // Android não deixou começar em segundo plano (ex.: reinício pelo sistema sem a tela aberta): volta ao abrir o app
      Estado.I.ultimoErro = "sem_primeiro_plano";
      pararServico();
      return START_NOT_STICKY;
    }
    if (!ativo) {
      ativo = true;
      gps.post(this::comecar);
    } else {
      gps.post(this::recarregar);
    }
    return START_STICKY;
  }

  /* ------------------------------------------------------------------ */
  /** Pasta da fila desta participação. Filas de participações anteriores não podem mais ser enviadas: saem. */
  private File pastaFila() {
    File raiz = new File(getFilesDir(), "fila");
    File[] outras = raiz.listFiles();
    if (outras != null) for (File f : outras) if (f.isDirectory() && !f.getName().equals(participanteAtivo)) apagar(f);
    return new File(raiz, participanteAtivo);
  }

  private static void apagar(File f) {
    File[] fs = f.listFiles();
    if (fs != null) for (File x : fs) apagar(x);
    //noinspection ResultOfMethodCallIgnored
    f.delete();
  }

  /** A página pediu para iniciar de novo: credenciais novas, ou outra participação (recomeça do zero). */
  private void recarregar() {
    if (!ativo) return;
    if (!cfg.participanteId().equals(participanteAtivo)) {
      if (fonte != null) fonte.parar();
      fonte = null;
      gps.removeCallbacksAndMessages(null);
      rede.removeCallbacksAndMessages(null);
      if (trava != null && trava.isHeld()) trava.release();
      if (aoTerRede != null) {
        try { ((ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE)).unregisterNetworkCallback(aoTerRede); } catch (Exception e) { /* já saiu */ }
        aoTerRede = null;
      }
      Estado.I.limparRecentes();
      comecar();
      return;
    }
    if (fila != null) sync = new Sincronizador(cfg.supabaseUrl(), cfg.supabaseChave(), cfg.dispositivoId(), cfg.segredo(), fila, null);
    if (filtro != null) filtro.cfg.intervaloParadoMs = cfg.intervaloParadoMs();
    agendarEnvio(0);
    avisarEstado();
  }

  private void comecar() {
    synchronized (this) { envioMarcadoPara = 0; }
    participanteAtivo = cfg.participanteId();
    FiltroGps.Cfg fc = new FiltroGps.Cfg();
    fc.intervaloParadoMs = cfg.intervaloParadoMs();
    filtro = new FiltroGps(fc);
    naoGravados.clear();
    try {
      fila = new FilaPontos(pastaFila());
    } catch (IOException e) {
      Estado.I.falhaGravacao = "sem_espaco";
      fila = null;
    }
    if (fila != null) {
      sync = new Sincronizador(cfg.supabaseUrl(), cfg.supabaseChave(), cfg.dispositivoId(), cfg.segredo(), fila, null);
      Estado.I.pendentes = fila.tamanho();
    }
    Estado e = Estado.I;
    e.rastreando = true;
    e.fim = null;
    e.ultimoErro = null;
    e.iniciadoEm = System.currentTimeMillis();
    e.gps = "aguardando";
    PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
    if (pm != null) {
      trava = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gbs:rastreio");
      trava.setReferenceCounted(false);
      trava.acquire();
    }
    fonte = FonteLocalizacao.criar(this);
    e.fonte = fonte.nome();
    fonte.iniciar(linhaGps.getLooper(), new FonteLocalizacao.Ouvinte() {
      @Override public void leitura(Location l) { aoLer(l); }
      @Override public void situacao(String s) {
        if ("ok".equals(s)) { if (!"ok".equals(Estado.I.gps) && !"fraco".equals(Estado.I.gps)) Estado.I.gps = "sem_sinal"; }
        else Estado.I.gps = s;
        avisarEstado();
      }
    });
    ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
    if (cm != null) {
      aoTerRede = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network n) { rede.post(() -> { Estado.I.falhas = 0; enviar(); sinal(true); }); }
      };
      try { cm.registerDefaultNetworkCallback(aoTerRede); } catch (Exception ex) { aoTerRede = null; }
    }
    gps.postDelayed(this::vigiarGps, 10000);
    rede.post(() -> sinal(true));
    rede.postDelayed(this::sinalPeriodico, SINAL_MS);
    agendarEnvio(0);
    avisarEstado();
  }

  private void aoLer(Location l) {
    if (!ativo || filtro == null) return;
    long agora = System.currentTimeMillis();
    FiltroGps.Resultado r = filtro.processar(l.getLatitude(), l.getLongitude(),
        l.hasAccuracy() ? (double) l.getAccuracy() : null, l.hasSpeed() ? (double) l.getSpeed() : null, l.getTime(), agora);
    Estado e = Estado.I;
    if (r.atual != null) {
      e.ultimaLeituraEm = agora;
      e.gps = r.atual.prec != null && r.atual.prec > 50 ? "fraco" : "ok";
      JSONObject o = new JSONObject();
      try {
        o.put("lat", l.getLatitude()).put("lng", l.getLongitude())
            .put("prec", l.hasAccuracy() ? l.getAccuracy() : JSONObject.NULL)
            .put("vel", l.hasSpeed() ? l.getSpeed() : JSONObject.NULL)
            .put("rumo", l.hasBearing() ? l.getBearing() : JSONObject.NULL)
            .put("alt", l.hasAltitude() ? l.getAltitude() : JSONObject.NULL)
            .put("t", l.getTime()).put("recebidaEm", agora);
      } catch (Exception ex) { /* valores finitos */ }
      e.emitir("leitura", o);
    }
    if (!r.pontos.isEmpty()) guardar(r.pontos, r.rapido);
  }

  /** Grava no aparelho; se o armazenamento falhar, os pontos ficam na memória e são regravados na próxima leitura. */
  private void guardar(List<FiltroGps.Ponto> pontos, boolean rapido) {
    naoGravados.addAll(pontos);
    if (fila == null) {
      try { fila = new FilaPontos(pastaFila()); } catch (IOException ex) { Estado.I.falhaGravacao = "sem_espaco"; avisarEstado(); return; }
      sync = new Sincronizador(cfg.supabaseUrl(), cfg.supabaseChave(), cfg.dispositivoId(), cfg.segredo(), fila, null);
    }
    List<FilaPontos.Item> itens;
    try {
      itens = fila.adicionar(new ArrayList<>(naoGravados));
      naoGravados.clear();
      Estado.I.falhaGravacao = null;
    } catch (IOException ex) {
      Estado.I.falhaGravacao = "falha_gravacao";
      avisarEstado();
      return;
    }
    Estado.I.guardarRecentes(itens);
    Estado.I.pendentes = fila.tamanho();
    JSONArray a = new JSONArray();
    for (FilaPontos.Item it : itens) a.put(Estado.ponto(it));
    JSONObject o = new JSONObject();
    try { o.put("pontos", a); } catch (Exception ex) { /* nunca */ }
    Estado.I.emitir("pontos", o);
    agendarEnvio(Estado.I.ultimoEnvioEm == 0 ? 300 : rapido ? 1000 : 1500);
    avisarEstado();
  }

  private void vigiarGps() {
    if (!ativo) return;
    long agora = System.currentTimeMillis();
    Estado e = Estado.I;
    if (!FonteLocalizacao.temPermissao(this)) e.gps = "negado";
    else if (!FonteLocalizacao.localizacaoLigada(this)) e.gps = "indisponivel";
    else if (agora - Math.max(e.ultimaLeituraEm, e.iniciadoEm) > SEM_GPS_MS && ("ok".equals(e.gps) || "fraco".equals(e.gps) || "aguardando".equals(e.gps))) e.gps = "sem_sinal";
    avisarEstado();
    gps.postDelayed(this::vigiarGps, 10000);
  }

  /* ------------------------------------------------------------------ */
  private synchronized void agendarEnvio(long ms) {
    long alvo = System.currentTimeMillis() + ms;
    if (envioMarcadoPara != 0 && envioMarcadoPara <= alvo) return;
    envioMarcadoPara = alvo;
    rede.removeCallbacks(envioRunnable);
    rede.postDelayed(envioRunnable, ms);
  }

  private final Runnable envioRunnable = () -> {
    synchronized (RastreioService.this) { envioMarcadoPara = 0; }
    enviar();
  };

  private void enviar() {
    if (!ativo || sync == null || fila == null || fila.tamanho() == 0) return;
    Sincronizador.Resultado r;
    try {
      r = sync.enviarLote(gpsParaServidor());
    } catch (IOException e) {
      Estado.I.falhaGravacao = "falha_gravacao";
      r = Sincronizador.Resultado.falha("falha_gravacao");
    }
    Estado e = Estado.I;
    e.pendentes = fila.tamanho();
    e.enviados = fila.enviados();
    e.recusados = fila.recusados();
    switch (r.tipo) {
      case OK:
        e.falhas = 0;
        e.ultimoErro = null;
        e.ultimoEnvioEm = System.currentTimeMillis();
        e.ultimoContatoEm = e.ultimoEnvioEm;
        if (r.intervaloS != null) aplicarIntervalo(r.intervaloS);
        if (fila.tamanho() > 0) agendarEnvio(300);
        break;
      case FALHA:
        e.falhas++;
        e.ultimoErro = r.motivo;
        agendarEnvio(Math.min(30000, 2000L << Math.min(e.falhas - 1, 4)));
        break;
      case FIM:
        final String motivo = r.motivo;
        gps.post(() -> encerrar(motivo, true));
        return;
    }
    avisarEstado();
  }

  private void sinalPeriodico() {
    if (!ativo) return;
    sinal(false);
    rede.postDelayed(this::sinalPeriodico, SINAL_MS);
  }

  private void sinal(boolean sempre) {
    if (!ativo || sync == null) return;
    if (!sempre && System.currentTimeMillis() - Estado.I.ultimoContatoEm < SINAL_MS - 5000) return;
    Sincronizador.Resultado r = sync.sinal(gpsParaServidor());
    Estado e = Estado.I;
    if (r.tipo == Sincronizador.Tipo.OK) {
      e.ultimoContatoEm = System.currentTimeMillis();
      if (r.intervaloS != null) aplicarIntervalo(r.intervaloS);
      if (fila != null && fila.tamanho() > 0) agendarEnvio(0);
    } else if (r.tipo == Sincronizador.Tipo.FIM) {
      gps.post(() -> encerrar(r.motivo, true));
      return;
    } else {
      e.ultimoErro = r.motivo;
    }
    avisarEstado();
  }

  private String gpsParaServidor() {
    String g = Estado.I.gps;
    return "ok".equals(g) || "fraco".equals(g) || "sem_sinal".equals(g) || "negado".equals(g) || "indisponivel".equals(g) ? g : null;
  }

  private void aplicarIntervalo(int s) {
    long ms = s * 1000L;
    if (ms < 5000 || ms > 300000) return;
    gps.post(() -> { if (filtro != null && filtro.cfg.intervaloParadoMs != ms) { filtro.cfg.intervaloParadoMs = ms; cfg.definirIntervalo(ms); } });
  }

  /* ------------------------------------------------------------------ */
  /** Fim da participação (servidor) ou pedido da página. A fila é apagada: o servidor não aceita mais nada. */
  private void encerrar(String motivo, boolean peloServidor) {
    if (!ativo) return;
    ativo = false;
    if (fila != null) fila.limpar();
    naoGravados.clear();
    cfg.encerrar(motivo);
    Estado e = Estado.I;
    e.rastreando = false;
    e.pendentes = 0;
    e.fim = motivo;
    e.limparRecentes();
    JSONObject o = new JSONObject();
    try { o.put("motivo", motivo).put("servidor", peloServidor); } catch (Exception ex) { /* nunca */ }
    e.emitir("finalizado", o);
    pararServico();
  }

  private void pararServico() {
    ativo = false;
    if (fonte != null) fonte.parar();
    fonte = null;
    if (aoTerRede != null) {
      try { ((ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE)).unregisterNetworkCallback(aoTerRede); } catch (Exception e) { /* já saiu */ }
      aoTerRede = null;
    }
    if (trava != null && trava.isHeld()) trava.release();
    Estado.I.rastreando = false;
    if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
    stopSelf();
  }

  @Override public void onDestroy() {
    if (ativo) pararServico();
    linhaGps.quitSafely();
    linhaRede.quitSafely();
    super.onDestroy();
  }

  /* ------------------------------------------------------------------ */
  private void avisarEstado() {
    Estado.I.emitir("estado", Estado.I.resumo());
    long agora = System.currentTimeMillis();
    String texto = textoNotificacao();
    if (ativo && !texto.equals(ultimoTextoNotif) && agora - ultimoAvisoNotif > 3000) {
      ultimoAvisoNotif = agora;
      ultimoTextoNotif = texto;
      NotificationManager nm = getSystemService(NotificationManager.class);
      if (nm != null) {
        try { nm.notify(NOTIF, notificacao()); } catch (Exception e) { /* sem permissão de aviso: o serviço segue */ }
      }
    }
  }

  private String textoNotificacao() {
    Estado e = Estado.I;
    if ("negado".equals(e.gps)) return getString(R.string.notif_negado);
    if ("indisponivel".equals(e.gps)) return getString(R.string.notif_desligada);
    if (e.pendentes > 0 && e.falhas > 0) return getString(R.string.notif_sem_internet, e.pendentes);
    if ("sem_sinal".equals(e.gps) || "aguardando".equals(e.gps)) return getString(R.string.notif_sem_gps);
    return getString(R.string.notif_ok);
  }

  private Notification notificacao() {
    Intent abrir = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    PendingIntent pi = PendingIntent.getActivity(this, 0, abrir, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    String op = cfg.operacao();
    return new NotificationCompat.Builder(this, CANAL)
        .setSmallIcon(R.drawable.ic_notificacao)
        .setContentTitle(op.isEmpty() ? getString(R.string.app_name) : getString(R.string.notif_titulo, op))
        .setContentText(textoNotificacao())
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(pi)
        .build();
  }
}
