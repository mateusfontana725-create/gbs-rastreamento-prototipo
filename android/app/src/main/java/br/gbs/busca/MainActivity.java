package br.gbs.busca;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONObject;

/**
 * Tela do aplicativo: a própria página do participante (civil.html) do servidor da operação, numa WebView presa a
 * esse servidor. A página fala com o aplicativo pelo objeto GBSNativo, que só existe para a origem do servidor
 * (addWebMessageListener com a regra de origem). O registro do GPS fica no RastreioService, fora da página.
 */
public class MainActivity extends Activity implements Estado.Ouvinte {

  private static final int PED_LOCALIZACAO = 1, PED_ARQUIVO = 2, PED_AVISOS = 3;

  private Config cfg;
  private WebView web;
  private FrameLayout raiz;
  private View painel;
  private JavaScriptReplyProxy resposta;
  private String origemCarregada;
  private boolean leuAreaTransferencia;
  private ValueCallback<Uri[]> escolhaArquivo;
  private Uri fotoCamera;
  private GeolocationPermissions.Callback geoCallback;
  private String geoOrigem;
  private final List<String> pedidosPermissao = new ArrayList<>();
  private boolean pontePronta;
  private boolean erroAoCarregar;

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    cfg = new Config(this);
    raiz = new FrameLayout(this);
    raiz.setBackgroundColor(Color.parseColor("#06080a"));
    setContentView(raiz);
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      mostrarPainel(getString(R.string.webview_antiga_titulo), getString(R.string.webview_antiga_texto), getString(R.string.atualizar_webview), () -> abrirExterno("market://details?id=com.google.android.webview"));
      return;
    }
    criarWebView();
    if (!tratarLink(getIntent())) carregar();
    Estado.I.ouvir(this);
  }

  @Override protected void onNewIntent(Intent i) {
    super.onNewIntent(i);
    setIntent(i);
    tratarLink(i);
  }

  @Override protected void onResume() {
    super.onResume();
    // o serviço pode ter sido parado pelo sistema: volta a registrar ao abrir o aplicativo
    if (cfg.rastreando() && cfg.prontoParaRastrear() && !Estado.I.rastreando && FonteLocalizacao.temPermissao(this)) RastreioService.iniciar(this);
    enviarEvento("estado", Estado.I.resumo());
  }

  @Override protected void onDestroy() {
    Estado.I.deixar(this);
    if (web != null) web.destroy();
    super.onDestroy();
  }

  @Override public void onBackPressed() {
    if (web != null && web.canGoBack()) web.goBack();
    else moveTaskToBack(true);   // não fecha: o registro continua em segundo plano
  }

  /* ------------------------------------------------------------------ */
  /* Página                                                              */
  /* ------------------------------------------------------------------ */
  @SuppressLint("SetJavaScriptEnabled")
  private void criarWebView() {
    web = new WebView(this);
    web.setBackgroundColor(Color.parseColor("#06080a"));
    raiz.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setGeolocationEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    s.setSupportMultipleWindows(false);
    s.setUserAgentString(s.getUserAgentString() + " GBSApp/" + BuildConfig.VERSION_NAME);
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
        Uri u = r.getUrl();
        String o = origemCarregada;
        if (o != null && ("https".equals(u.getScheme())) && o.equals(Config.origemValidaSemFixa(u))) return false;
        abrirExterno(u.toString());   // mapas, telefone, outros sites: fora do aplicativo
        return true;
      }
      @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icone) { erroAoCarregar = false; }
      @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
        if (r.isForMainFrame()) { erroAoCarregar = true; mostrarSemPagina(); }
      }
      @Override public void onPageFinished(WebView v, String url) {
        if (!erroAoCarregar && painel != null && url != null && url.startsWith(String.valueOf(origemCarregada))) esconderPainel();
      }
    });
    web.setWebChromeClient(new WebChromeClient() {
      @Override public void onGeolocationPermissionsShowPrompt(String origem, GeolocationPermissions.Callback cb) {
        if (origemCarregada == null || !origemCarregada.equals(Config.origemValidaSemFixa(Uri.parse(origem)))) { cb.invoke(origem, false, false); return; }
        if (FonteLocalizacao.temPermissao(MainActivity.this)) { cb.invoke(origem, true, false); return; }
        geoCallback = cb;
        geoOrigem = origem;
        pedirLocalizacao();
      }
      @Override public void onPermissionRequest(PermissionRequest r) { r.deny(); }
      @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
        if (escolhaArquivo != null) escolhaArquivo.onReceiveValue(null);
        escolhaArquivo = cb;
        Intent i;
        if (p.isCaptureEnabled()) {
          try {
            File pasta = new File(getCacheDir(), "fotos");
            //noinspection ResultOfMethodCallIgnored
            pasta.mkdirs();
            File f = File.createTempFile("foto", ".jpg", pasta);
            fotoCamera = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".arquivos", f);
            i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, fotoCamera)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
          } catch (Exception e) {
            fotoCamera = null;
            i = p.createIntent();
          }
        } else {
          fotoCamera = null;
          i = p.createIntent();
        }
        try {
          startActivityForResult(i, PED_ARQUIVO);
        } catch (ActivityNotFoundException e) {
          escolhaArquivo = null;
          cb.onReceiveValue(null);
          return false;
        }
        return true;
      }
    });
  }

  private void ligarPonte(String origem) {
    if (pontePronta) return;
    WebViewCompat.addWebMessageListener(web, "GBSNativo", Collections.singleton(origem),
        (view, msg, origemMsg, principal, proxy) -> {
          if (!principal) return;
          resposta = proxy;
          aoReceber(msg);
        });
    pontePronta = true;
  }

  /** Abre a página da operação guardada (ou a tela de boas-vindas, se ainda não há operação). */
  private void carregar() {
    String origem = cfg.origem(), token = cfg.token();
    if (origem == null || !Config.tokenValido(token)) {
      mostrarBoasVindas();
      return;
    }
    if (!origem.equals(origemCarregada)) {
      if (pontePronta) { recriarWebView(); }
      origemCarregada = origem;
      ligarPonte(origem);
    }
    String v = cfg.vinculoPendente();
    String hash = "t=" + token + "&app=1" + (Config.codigoValido(v) ? "&v=" + v : "");
    web.loadUrl(origem + "/civil.html#" + hash);
  }

  private void recriarWebView() {
    raiz.removeView(web);
    web.destroy();
    pontePronta = false;
    resposta = null;
    criarWebView();
  }

  /* ------------------------------------------------------------------ */
  /* Link de abertura (gbsbusca://vincular?o=…&t=…&v=…)                   */
  /* ------------------------------------------------------------------ */
  private boolean tratarLink(Intent i) {
    if (i == null || i.getData() == null) return false;
    return aplicarLink(i.getData(), true);
  }

  /** Link do botão "Abrir no aplicativo" (ou colado / da área de transferência). */
  private boolean aplicarLink(Uri u, boolean avisar) {
    String origem = null, token = null, v = null;
    if ("gbsbusca".equals(u.getScheme()) && "vincular".equals(u.getHost())) {
      origem = Config.origemValida(u.getQueryParameter("o"));
      token = u.getQueryParameter("t");
      v = u.getQueryParameter("v");
    } else if ("https".equals(u.getScheme())) {
      // link da operação colado: https://servidor/civil.html#t=…
      origem = Config.origemValida(u.getScheme() + "://" + u.getAuthority());
      String frag = u.getFragment();
      if (frag != null) for (String par : frag.split("&")) if (par.startsWith("t=")) token = par.substring(2);
    }
    if (token != null) token = token.toLowerCase(java.util.Locale.ROOT);
    if (v != null) v = v.toLowerCase(java.util.Locale.ROOT);
    if (origem == null || !Config.tokenValido(token)) {
      if (avisar) Toast.makeText(this, R.string.link_invalido, Toast.LENGTH_LONG).show();
      return false;
    }
    String atual = cfg.origem();
    final String o = origem, t = token, c = Config.codigoValido(v) ? v : null;
    Runnable aplicar = () -> {
      cfg.definirOperacao(o, t, c);
      if (c == null) cfg.esquecerVinculo();
      if (web != null) carregar();
    };
    if (cfg.rastreando() && (!o.equals(atual) || !t.equals(cfg.token()))) {
      // já registrando outra busca: confirma antes de trocar
      new AlertDialog.Builder(this).setTitle(R.string.trocar_titulo).setMessage(R.string.trocar_texto)
          .setPositiveButton(R.string.trocar_sim, (d, w) -> aplicar.run())
          .setNegativeButton(R.string.cancelar, null).show();
      return true;
    }
    aplicar.run();
    return true;
  }

  @Override public void onWindowFocusChanged(boolean foco) {
    super.onWindowFocusChanged(foco);
    // Primeira abertura depois de instalar: o botão "Baixar aplicativo" da página deixou o link na área de transferência.
    if (!foco || leuAreaTransferencia || cfg.origem() != null) return;
    leuAreaTransferencia = true;
    Uri u = linkDaAreaTransferencia();
    if (u != null && aplicarLink(u, false)) {
      limparAreaTransferencia();
      Toast.makeText(this, R.string.link_colado, Toast.LENGTH_LONG).show();
    }
  }

  private Uri linkDaAreaTransferencia() {
    try {
      ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
      if (cm == null || !cm.hasPrimaryClip() || cm.getPrimaryClip() == null || cm.getPrimaryClip().getItemCount() == 0) return null;
      CharSequence txt = cm.getPrimaryClip().getItemAt(0).coerceToText(this);
      if (txt == null) return null;
      String s = txt.toString().trim();
      if (!s.startsWith("gbsbusca://vincular?") && !(s.startsWith("https://") && s.contains("#t="))) return null;
      return Uri.parse(s);
    } catch (Exception e) {
      return null;
    }
  }

  private void limparAreaTransferencia() {
    try {
      ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
      if (cm == null) return;
      if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip();
      else cm.setPrimaryClip(ClipData.newPlainText("", ""));
    } catch (Exception e) { /* nada */ }
  }

  /* ------------------------------------------------------------------ */
  /* Ponte com a página                                                  */
  /* ------------------------------------------------------------------ */
  private void aoReceber(WebMessageCompat msg) {
    String id = null;
    try {
      JSONObject m = new JSONObject(msg.getData());
      id = m.optString("id", null);
      String acao = m.optString("acao");
      JSONObject d = m.optJSONObject("dados");
      if (d == null) d = new JSONObject();
      switch (acao) {
        case "ola": responder(id, info()); break;
        case "permissao": pedirPermissaoPelaPagina(id); break;
        case "posicao": posicaoAtual(id); break;
        case "iniciar": responder(id, iniciarRastreio(d)); break;
        case "parar":
          RastreioService.parar(this, d.optString("motivo", "pagina"));
          responder(id, new JSONObject().put("ok", true));
          break;
        case "estado": responder(id, Estado.I.resumo()); break;
        case "pontos": responder(id, new JSONObject().put("pontos", Estado.I.recentesJson())); break;
        case "vinculoUsado": cfg.esquecerVinculo(); responder(id, new JSONObject().put("ok", true)); break;
        case "bateria": responder(id, new JSONObject().put("ignorando", pedirBateria())); break;
        case "configuracoes": abrirConfiguracoesDoApp(); responder(id, new JSONObject().put("ok", true)); break;
        case "localizacaoDoCelular": startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)); responder(id, new JSONObject().put("ok", true)); break;
        case "notificar": Avisos.mensagem(this, d.optString("titulo"), d.optString("texto")); responder(id, new JSONObject().put("ok", true)); break;
        default: responder(id, new JSONObject().put("erro", "acao_desconhecida"));
      }
    } catch (Exception e) {
      try { responder(id, new JSONObject().put("erro", "falha")); } catch (Exception ignorada) { /* sem resposta */ }
    }
  }

  private JSONObject info() throws Exception {
    JSONObject o = new JSONObject();
    o.put("versao", BuildConfig.VERSION_NAME).put("codigo", BuildConfig.VERSION_CODE)
        .put("modelo", (Build.MANUFACTURER + " " + Build.MODEL).trim())
        .put("android", Build.VERSION.SDK_INT)
        .put("participante", cfg.participanteId() == null ? JSONObject.NULL : cfg.participanteId())
        .put("temAparelho", cfg.segredo() != null)
        .put("rastreandoConfig", cfg.rastreando())
        .put("fim", cfg.fim() == null ? JSONObject.NULL : cfg.fim())
        .put("permissao", FonteLocalizacao.temPermissao(this) ? "concedida" : "pendente")
        .put("localizacaoLigada", FonteLocalizacao.localizacaoLigada(this))
        .put("bateriaLiberada", bateriaLiberada())
        .put("estado", Estado.I.resumo());
    return o;
  }

  /** A página entrega a configuração (e, na primeira vez, o segredo do aparelho) e o serviço começa. */
  private JSONObject iniciarRastreio(JSONObject d) throws Exception {
    String part = d.optString("participanteId", "");
    String disp = d.isNull("dispositivoId") ? null : d.optString("dispositivoId", null);
    String seg = d.isNull("segredo") ? null : d.optString("segredo", null);
    String url = d.optString("supabaseUrl", ""), chave = d.optString("supabaseKey", "");
    if (!url.startsWith("https://") || chave.isEmpty() || !part.matches("^[0-9a-f-]{36}$")) return new JSONObject().put("ok", false).put("erro", "dados_invalidos");
    boolean novoSegredo = disp != null && seg != null && seg.matches("^[0-9a-f]{64}$");
    if (!novoSegredo && !(part.equals(cfg.participanteId()) && cfg.segredo() != null)) return new JSONObject().put("ok", false).put("erro", "sem_aparelho");
    if (!FonteLocalizacao.temPermissao(this)) return new JSONObject().put("ok", false).put("erro", "negado");
    cfg.definirRastreio(url, chave, part, novoSegredo ? disp : null, novoSegredo ? seg : null,
        Math.max(5000, Math.min(300000, d.optLong("intervaloParadoMs", 15000))), d.optString("nome"), d.optString("operacao"));
    if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, PED_AVISOS);
    }
    RastreioService.iniciar(this);
    return new JSONObject().put("ok", true);
  }

  private void pedirPermissaoPelaPagina(String id) throws Exception {
    if (FonteLocalizacao.temPermissao(this)) { responder(id, new JSONObject().put("localizacao", "concedida")); return; }
    pedidosPermissao.add(id);
    pedirLocalizacao();
  }

  private void pedirLocalizacao() {
    requestPermissions(new String[] { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, PED_LOCALIZACAO);
  }

  @Override public void onRequestPermissionsResult(int pedido, String[] perms, int[] res) {
    super.onRequestPermissionsResult(pedido, perms, res);
    if (pedido != PED_LOCALIZACAO) return;
    boolean ok = FonteLocalizacao.temPermissao(this);
    if (geoCallback != null) { geoCallback.invoke(geoOrigem, ok, false); geoCallback = null; }
    // negada sem poder perguntar de novo: só pelas configurações do Android
    String r = ok ? "concedida" : (shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION) ? "negada" : "bloqueada");
    for (String id : pedidosPermissao) {
      try { responder(id, new JSONObject().put("localizacao", r)); } catch (Exception e) { /* nada */ }
    }
    pedidosPermissao.clear();
    if (ok && cfg.rastreando() && cfg.prontoParaRastrear()) RastreioService.iniciar(this);
  }

  private void posicaoAtual(String id) {
    FonteLocalizacao.atual(this, 20000, (l, erro) -> {
      try {
        JSONObject o = new JSONObject();
        if (l == null) o.put("erro", erro);
        else o.put("lat", l.getLatitude()).put("lng", l.getLongitude()).put("prec", l.hasAccuracy() ? l.getAccuracy() : JSONObject.NULL)
            .put("vel", l.hasSpeed() ? l.getSpeed() : JSONObject.NULL).put("t", l.getTime());
        responder(id, o);
      } catch (Exception e) { /* nada */ }
    });
  }

  private boolean bateriaLiberada() {
    PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
    return pm == null || pm.isIgnoringBatteryOptimizations(getPackageName());
  }

  @SuppressLint("BatteryLife")
  private boolean pedirBateria() {
    if (bateriaLiberada()) return true;
    try {
      startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
    } catch (Exception e) {
      try { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); } catch (Exception ignorada) { /* sem a tela */ }
    }
    return false;
  }

  private void abrirConfiguracoesDoApp() {
    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
  }

  private void responder(String id, JSONObject dados) {
    if (id == null) return;
    JSONObject m = new JSONObject();
    try { m.put("id", id).put("dados", dados); } catch (Exception e) { return; }
    postar(m);
  }

  private void enviarEvento(String tipo, JSONObject dados) {
    JSONObject m = new JSONObject();
    try { m.put("evento", tipo).put("dados", dados); } catch (Exception e) { return; }
    postar(m);
  }

  private void postar(JSONObject m) {
    runOnUiThread(() -> {
      if (resposta == null) return;
      try { resposta.postMessage(m.toString()); } catch (Exception e) { /* página trocando */ }
    });
  }

  @Override public void evento(String tipo, JSONObject dados) { enviarEvento(tipo, dados); }

  /* ------------------------------------------------------------------ */
  @Override protected void onActivityResult(int pedido, int resultado, Intent dados) {
    super.onActivityResult(pedido, resultado, dados);
    if (pedido != PED_ARQUIVO || escolhaArquivo == null) return;
    Uri[] r = null;
    if (resultado == RESULT_OK) {
      if (fotoCamera != null) r = new Uri[] { fotoCamera };
      else r = WebChromeClient.FileChooserParams.parseResult(resultado, dados);
    }
    escolhaArquivo.onReceiveValue(r);
    escolhaArquivo = null;
    fotoCamera = null;
  }

  private void abrirExterno(String url) {
    try {
      Intent i = url.startsWith("intent:") ? Intent.parseUri(url, Intent.URI_INTENT_SCHEME) : new Intent(Intent.ACTION_VIEW, Uri.parse(url));
      i.addCategory(Intent.CATEGORY_BROWSABLE);
      i.setComponent(null);
      i.setSelector(null);
      startActivity(i);
    } catch (Exception e) {
      Toast.makeText(this, R.string.sem_app_para_abrir, Toast.LENGTH_SHORT).show();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Telas do próprio aplicativo (sem a página)                          */
  /* ------------------------------------------------------------------ */
  private void mostrarBoasVindas() {
    mostrarPainel(getString(R.string.boas_vindas_titulo), getString(R.string.boas_vindas_texto), getString(R.string.colar_link), () -> {
      Uri u = linkDaAreaTransferencia();
      if (u == null || !aplicarLink(u, true)) Toast.makeText(this, R.string.sem_link_copiado, Toast.LENGTH_LONG).show();
      else limparAreaTransferencia();
    });
  }

  private void mostrarSemPagina() {
    Estado e = Estado.I;
    String texto = getString(R.string.sem_pagina_texto) + (e.rastreando ? "\n\n" + getString(R.string.sem_pagina_registrando, e.pendentes) : "");
    mostrarPainel(getString(R.string.sem_pagina_titulo), texto, getString(R.string.tentar_de_novo), () -> { esconderPainel(); carregar(); });
  }

  private void mostrarPainel(String titulo, String texto, String botao, Runnable acao) {
    esconderPainel();
    LinearLayout l = new LinearLayout(this);
    l.setOrientation(LinearLayout.VERTICAL);
    l.setGravity(Gravity.CENTER);
    l.setBackgroundColor(Color.parseColor("#06080a"));
    int pad = (int) (24 * getResources().getDisplayMetrics().density);
    l.setPadding(pad, pad, pad, pad);
    TextView marca = new TextView(this);
    marca.setText("GBS");
    marca.setTextColor(Color.parseColor("#f97316"));
    marca.setTextSize(28);
    marca.setGravity(Gravity.CENTER);
    TextView t = new TextView(this);
    t.setText(titulo);
    t.setTextColor(Color.WHITE);
    t.setTextSize(20);
    t.setGravity(Gravity.CENTER);
    t.setPadding(0, pad / 2, 0, pad / 2);
    TextView x = new TextView(this);
    x.setText(texto);
    x.setTextColor(Color.parseColor("#cbd5e1"));
    x.setTextSize(16);
    x.setGravity(Gravity.CENTER);
    l.addView(marca);
    l.addView(t);
    l.addView(x);
    if (botao != null) {
      Button b = new Button(this);
      b.setText(botao);
      b.setOnClickListener(v -> acao.run());
      LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
      lp.topMargin = pad;
      l.addView(b, lp);
    }
    painel = l;
    raiz.addView(l, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
  }

  private void esconderPainel() {
    if (painel != null) raiz.removeView(painel);
    painel = null;
  }
}
