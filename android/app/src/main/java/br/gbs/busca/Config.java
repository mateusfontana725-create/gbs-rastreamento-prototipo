package br.gbs.busca;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

/**
 * O que o aplicativo guarda (memória interna do app, fora do backup): o servidor, a operação, a participação e o
 * segredo do aparelho. O segredo nunca volta para a página; só o serviço de GPS o usa.
 */
final class Config {
  private static final String ARQ = "gbs";
  private final SharedPreferences p;

  Config(Context c) { p = c.getApplicationContext().getSharedPreferences(ARQ, Context.MODE_PRIVATE); }

  String origem() { return p.getString("origem", null); }
  String token() { return p.getString("token", null); }
  String participanteId() { return p.getString("participante", null); }
  String dispositivoId() { return p.getString("dispositivo", null); }
  String segredo() { return p.getString("segredo", null); }
  String supabaseUrl() { return p.getString("supabase_url", null); }
  String supabaseChave() { return p.getString("supabase_chave", null); }
  long intervaloParadoMs() { return p.getLong("intervalo_ms", 15000); }
  boolean rastreando() { return p.getBoolean("rastreando", false); }
  String nome() { return p.getString("nome", ""); }
  String operacao() { return p.getString("operacao", ""); }
  String vinculoPendente() { return p.getString("vinculo", null); }
  String fim() { return p.getString("fim", null); }

  boolean prontoParaRastrear() {
    return supabaseUrl() != null && supabaseChave() != null && participanteId() != null && dispositivoId() != null && segredo() != null;
  }

  /** Origem aceita: https, sem caminho. Com origem fixada na compilação, só ela. */
  static String origemValida(String o) {
    if (o == null) return null;
    Uri u = Uri.parse(o.trim());
    if (!"https".equals(u.getScheme()) || u.getHost() == null || u.getHost().isEmpty()) return null;
    String norm = "https://" + u.getHost().toLowerCase(java.util.Locale.ROOT) + (u.getPort() > 0 ? ":" + u.getPort() : "");
    String fixa = BuildConfig.ORIGEM;
    if (fixa != null && !fixa.isEmpty() && !fixa.equals(norm)) return null;
    return norm;
  }

  /** Origem de um endereço qualquer (para comparar com a do servidor). */
  static String origemValidaSemFixa(Uri u) {
    if (u == null || !"https".equals(u.getScheme()) || u.getHost() == null || u.getHost().isEmpty()) return null;
    return "https://" + u.getHost().toLowerCase(java.util.Locale.ROOT) + (u.getPort() > 0 ? ":" + u.getPort() : "");
  }

  static boolean tokenValido(String t) { return t != null && t.matches("^[0-9a-f]{64}$"); }
  static boolean codigoValido(String v) { return v != null && v.matches("^[0-9a-f]{32}$"); }

  void definirOperacao(String origem, String token, String vinculo) {
    SharedPreferences.Editor e = p.edit().putString("origem", origem).putString("token", token);
    if (vinculo != null) e.putString("vinculo", vinculo);
    e.apply();
  }

  void esquecerVinculo() { p.edit().remove("vinculo").apply(); }

  void definirRastreio(String supabaseUrl, String chave, String participante, String dispositivo, String segredo,
                       long intervaloMs, String nome, String operacao) {
    SharedPreferences.Editor e = p.edit()
        .putString("supabase_url", supabaseUrl).putString("supabase_chave", chave)
        .putString("participante", participante).putLong("intervalo_ms", intervaloMs)
        .putString("nome", nome == null ? "" : nome).putString("operacao", operacao == null ? "" : operacao)
        .putBoolean("rastreando", true).remove("fim");
    if (dispositivo != null && segredo != null) e.putString("dispositivo", dispositivo).putString("segredo", segredo);
    e.commit();
  }

  void definirIntervalo(long ms) { p.edit().putLong("intervalo_ms", ms).apply(); }

  /** Fim da participação: o segredo é apagado (o servidor também não o aceita mais). */
  void encerrar(String motivo) {
    p.edit().putBoolean("rastreando", false).remove("segredo").remove("dispositivo").putString("fim", motivo).commit();
  }
}
