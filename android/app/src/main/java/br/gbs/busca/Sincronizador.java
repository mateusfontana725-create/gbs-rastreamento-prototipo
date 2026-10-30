package br.gbs.busca;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Envio dos pontos guardados e do sinal de vida direto ao Supabase, sem a sessão do navegador:
 * quem autoriza é o segredo deste aparelho (app_enviar_posicoes / app_sinal_vida, migração 051).
 * Um ponto só sai da fila com a confirmação do servidor (mesma regra da página).
 */
public final class Sincronizador {

  public interface Http {
    Resposta post(String url, Map<String, String> cabecalhos, String corpo, int tempoMs) throws IOException;
  }

  public static final class Resposta {
    public final int status;
    public final String corpo;
    public final long dataServidorMs;
    public Resposta(int status, String corpo, long dataServidorMs) { this.status = status; this.corpo = corpo; this.dataServidorMs = dataServidorMs; }
  }

  public enum Tipo { OK, FALHA, FIM }

  public static final class Resultado {
    public final Tipo tipo;
    public final String motivo;
    public final int confirmados;
    public final int recusados;
    public final Integer intervaloS;
    Resultado(Tipo tipo, String motivo, int confirmados, int recusados, Integer intervaloS) {
      this.tipo = tipo; this.motivo = motivo; this.confirmados = confirmados; this.recusados = recusados; this.intervaloS = intervaloS;
    }
    static Resultado falha(String motivo) { return new Resultado(Tipo.FALHA, motivo, 0, 0, null); }
    static Resultado fim(String motivo) { return new Resultado(Tipo.FIM, motivo, 0, 0, null); }
  }

  /** Códigos do servidor que encerram a participação neste aparelho → motivo mostrado na página. */
  private static final String[][] FINAIS = {
      { "operacao_encerrada", "encerrada" }, { "participante_removido", "removido" },
      { "participante_liberado", "liberado" }, { "participante_invalido", "inexistente" },
      { "aparelho_app_invalido", "aparelho" },
  };

  public static final int LOTE = 200;
  private static final long DESVIO_MINIMO_MS = 30000;

  private final String url, chave, dispositivo, segredo;
  private final FilaPontos fila;
  private final Http http;
  private volatile long desvioRelogioMs;

  public Sincronizador(String supabaseUrl, String chave, String dispositivo, String segredo, FilaPontos fila, Http http) {
    this.url = supabaseUrl.replaceAll("/+$", "");
    this.chave = chave; this.dispositivo = dispositivo; this.segredo = segredo; this.fila = fila;
    this.http = http != null ? http : new HttpPadrao();
  }

  public long desvioRelogioMs() { return desvioRelogioMs; }

  private Map<String, String> cabecalhos() {
    Map<String, String> h = new LinkedHashMap<>();
    h.put("apikey", chave);
    // chave antiga (anon, um JWT) também vai no Authorization; a publicável nova vai só no apikey
    if (chave.startsWith("eyJ")) h.put("Authorization", "Bearer " + chave);
    h.put("Content-Type", "application/json");
    h.put("Accept", "application/json");
    return h;
  }

  private Resposta chamar(String funcao, JSONObject args, int tempoMs) throws IOException {
    long t0 = System.currentTimeMillis();
    Resposta r = http.post(url + "/rest/v1/rpc/" + funcao, cabecalhos(), args.toString(), tempoMs);
    long t1 = System.currentTimeMillis();
    if (r.dataServidorMs > 0) desvioRelogioMs = r.dataServidorMs + 500 - (t0 + t1) / 2;
    return r;
  }

  /** Erro do PostgREST → fim da participação, ou falha temporária. */
  static Resultado erro(Resposta r) {
    String txt = r.corpo == null ? "" : r.corpo;
    for (String[] f : FINAIS) if (txt.contains(f[0])) return Resultado.fim(f[1]);
    if (txt.contains("PGRST202") || txt.contains("Could not find the function")) return Resultado.falha("funcao_ausente");
    if (txt.contains("lote_invalido")) return new Resultado(Tipo.FALHA, "lote_invalido", 0, 0, null);
    return Resultado.falha(r.status >= 500 ? "servidor" : "recusado_" + r.status);
  }

  /** Envia até LOTE pontos da fila. Confirmados e recusados de vez saem da fila. */
  public Resultado enviarLote(String gps) throws IOException {
    List<FilaPontos.Item> lote = fila.pendentes(LOTE);
    if (lote.isEmpty()) return new Resultado(Tipo.OK, null, 0, 0, null);
    long desvio = Math.abs(desvioRelogioMs) >= DESVIO_MINIMO_MS ? desvioRelogioMs : 0;
    JSONObject args = new JSONObject();
    try {
      JSONArray pontos = new JSONArray();
      for (FilaPontos.Item it : lote) {
        JSONObject p = new JSONObject();
        p.put("id", it.id).put("lat", it.lat).put("lng", it.lng).put("prec", it.prec == null ? JSONObject.NULL : it.prec).put("t", it.t + desvio);
        pontos.put(p);
      }
      args.put("p_dispositivo", dispositivo).put("p_segredo", segredo).put("p_pontos", pontos).put("p_gps", gps == null ? JSONObject.NULL : gps);
    } catch (JSONException e) {
      return Resultado.falha("dados");
    }
    Resposta r;
    try {
      r = chamar("app_enviar_posicoes", args, 20000);
    } catch (IOException e) {
      return Resultado.falha("rede");
    }
    if (r.status < 200 || r.status >= 300) {
      Resultado e = erro(r);
      if ("lote_invalido".equals(e.motivo)) {
        // dados corrompidos: este lote é recusado para não travar a fila (como a página faz)
        List<String> ids = new ArrayList<>();
        for (FilaPontos.Item it : lote) ids.add(it.id);
        fila.remover(null, ids);
        return new Resultado(Tipo.OK, "lote_invalido", 0, ids.size(), null);
      }
      return e;
    }
    JSONObject o;
    try { o = new JSONObject(r.corpo); } catch (Exception e) { return Resultado.falha("resposta_sem_confirmacao"); }
    List<String> conf = new ArrayList<>(), rec = new ArrayList<>();
    JSONArray c = o.optJSONArray("confirmados");
    if (c != null) for (int i = 0; i < c.length(); i++) conf.add(c.optString(i));
    JSONArray x = o.optJSONArray("recusados");
    if (x != null) for (int i = 0; i < x.length(); i++) { JSONObject y = x.optJSONObject(i); if (y != null) rec.add(y.optString("id")); }
    if (conf.isEmpty() && rec.isEmpty()) return Resultado.falha("resposta_sem_confirmacao");
    fila.remover(conf, rec);
    Integer intervalo = o.has("gps_intervalo_s") && !o.isNull("gps_intervalo_s") ? o.optInt("gps_intervalo_s") : null;
    return new Resultado(Tipo.OK, null, conf.size(), rec.size(), intervalo);
  }

  /** "Estou conectado" (o painel mostra o participante como ativo mesmo parado). */
  public Resultado sinal(String gps) {
    JSONObject args = new JSONObject();
    try {
      args.put("p_dispositivo", dispositivo).put("p_segredo", segredo).put("p_gps", gps == null ? JSONObject.NULL : gps);
    } catch (JSONException e) {
      return Resultado.falha("dados");
    }
    Resposta r;
    try {
      r = chamar("app_sinal_vida", args, 12000);
    } catch (IOException e) {
      return Resultado.falha("rede");
    }
    if (r.status < 200 || r.status >= 300) return erro(r);
    try {
      JSONObject o = new JSONObject(r.corpo);
      String status = o.optString("status", "");
      if (!"ativa".equals(status)) {
        String m = "removido".equals(status) || "liberado".equals(status) || "inexistente".equals(status) ? status : "encerrada";
        return Resultado.fim(m);
      }
      Integer intervalo = o.has("gps_intervalo_s") && !o.isNull("gps_intervalo_s") ? o.optInt("gps_intervalo_s") : null;
      return new Resultado(Tipo.OK, null, 0, 0, intervalo);
    } catch (Exception e) {
      return Resultado.falha("servidor");
    }
  }

  /** HTTP simples (HttpURLConnection): sem bibliotecas extras. */
  public static final class HttpPadrao implements Http {
    @Override
    public Resposta post(String endereco, Map<String, String> cabecalhos, String corpo, int tempoMs) throws IOException {
      HttpURLConnection c = (HttpURLConnection) URI.create(endereco).toURL().openConnection();
      try {
        c.setRequestMethod("POST");
        c.setConnectTimeout(tempoMs);
        c.setReadTimeout(tempoMs);
        c.setDoOutput(true);
        c.setUseCaches(false);
        for (Map.Entry<String, String> h : cabecalhos.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
        byte[] b = corpo.getBytes(StandardCharsets.UTF_8);
        c.setFixedLengthStreamingMode(b.length);
        try (OutputStream out = c.getOutputStream()) { out.write(b); }
        int status = c.getResponseCode();
        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
        String txt = "";
        if (in != null) {
          try (InputStream i = in) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] tmp = new byte[8192];
            int n;
            while ((n = i.read(tmp)) > 0) buf.write(tmp, 0, n);
            txt = new String(buf.toByteArray(), StandardCharsets.UTF_8);
          }
        }
        return new Resposta(status, txt, dataHttp(c.getHeaderField("Date")));
      } finally {
        c.disconnect();
      }
    }
  }

  static long dataHttp(String v) {
    if (v == null) return 0;
    try {
      SimpleDateFormat f = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US);
      f.setTimeZone(TimeZone.getTimeZone("GMT"));
      return f.parse(v).getTime();
    } catch (Exception e) {
      return 0;
    }
  }
}
