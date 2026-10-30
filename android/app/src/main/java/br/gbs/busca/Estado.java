package br.gbs.busca;

import java.util.ArrayDeque;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.json.JSONArray;
import org.json.JSONObject;

/** Situação do registro neste aparelho, compartilhada entre o serviço de GPS e a tela (mesmo processo). */
final class Estado {
  interface Ouvinte { void evento(String tipo, JSONObject dados); }

  static final Estado I = new Estado();
  private static final int MAX_RECENTES = 3000;

  private final CopyOnWriteArrayList<Ouvinte> ouvintes = new CopyOnWriteArrayList<>();
  private final ArrayDeque<FilaPontos.Item> recentes = new ArrayDeque<>();

  volatile boolean rastreando;
  volatile int pendentes;
  volatile long ultimoEnvioEm;
  volatile long ultimoContatoEm;
  volatile long enviados;
  volatile long recusados;
  volatile int falhas;
  volatile String ultimoErro;
  volatile String gps = "aguardando";
  volatile long ultimaLeituraEm;
  volatile String falhaGravacao;
  volatile String fim;
  volatile long iniciadoEm;
  volatile String fonte = "";

  void ouvir(Ouvinte o) { ouvintes.addIfAbsent(o); }
  void deixar(Ouvinte o) { ouvintes.remove(o); }

  void emitir(String tipo, JSONObject dados) {
    for (Ouvinte o : ouvintes) {
      try { o.evento(tipo, dados); } catch (Exception e) { /* um ouvinte com problema não para os outros */ }
    }
  }

  synchronized void guardarRecentes(List<FilaPontos.Item> itens) {
    for (FilaPontos.Item it : itens) {
      recentes.addLast(it);
      if (recentes.size() > MAX_RECENTES) recentes.removeFirst();
    }
  }

  synchronized JSONArray recentesJson() {
    JSONArray a = new JSONArray();
    for (FilaPontos.Item it : recentes) a.put(ponto(it));
    return a;
  }

  synchronized void limparRecentes() { recentes.clear(); }

  static JSONObject ponto(FilaPontos.Item it) {
    JSONObject o = new JSONObject();
    try {
      o.put("id", it.id).put("lat", it.lat).put("lng", it.lng).put("prec", it.prec == null ? JSONObject.NULL : it.prec).put("t", it.t);
    } catch (Exception e) { /* valores sempre finitos */ }
    return o;
  }

  JSONObject resumo() {
    JSONObject o = new JSONObject();
    try {
      o.put("rastreando", rastreando).put("pendentes", pendentes).put("ultimoEnvioEm", ultimoEnvioEm)
          .put("ultimoContatoEm", ultimoContatoEm).put("enviados", enviados).put("recusados", recusados)
          .put("falhas", falhas).put("ultimoErro", ultimoErro == null ? JSONObject.NULL : ultimoErro)
          .put("gps", gps).put("ultimaLeituraEm", ultimaLeituraEm)
          .put("falhaGravacao", falhaGravacao == null ? JSONObject.NULL : falhaGravacao)
          .put("fim", fim == null ? JSONObject.NULL : fim).put("iniciadoEm", iniciadoEm).put("fonte", fonte);
    } catch (Exception e) { /* nunca acontece com estes tipos */ }
    return o;
  }
}
