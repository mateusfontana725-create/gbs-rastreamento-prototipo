package br.gbs.busca;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class FilaSincronizadorTest {

  private static File pasta() throws IOException { return Files.createTempDirectory("fila").toFile(); }

  private static List<FiltroGps.Ponto> pontos(int n, long t0) {
    List<FiltroGps.Ponto> l = new ArrayList<>();
    for (int i = 0; i < n; i++) l.add(new FiltroGps.Ponto(-25.43 + i * 1e-5, -49.27, i % 3 == 0 ? null : 4.5, t0 + i * 1000));
    return l;
  }

  /** Servidor falso: confirma tudo, ou responde com o que o teste mandar. */
  private static class Falso implements Sincronizador.Http {
    final List<JSONObject> pedidos = new ArrayList<>();
    final List<Map<String, String>> cabecalhos = new ArrayList<>();
    int status = 200;
    String corpoErro;
    boolean semRede;
    long data;
    @Override
    public Sincronizador.Resposta post(String url, Map<String, String> h, String corpo, int tempoMs) throws IOException {
      if (semRede) throw new IOException("sem rede");
      try {
        return responder(url, h, corpo);
      } catch (org.json.JSONException e) {
        throw new IOException(e);
      }
    }

    Sincronizador.Resposta responder(String url, Map<String, String> h, String corpo) throws org.json.JSONException {
      JSONObject a = new JSONObject(corpo);
      a.put("__url", url);
      pedidos.add(a);
      cabecalhos.add(h);
      if (status != 200) return new Sincronizador.Resposta(status, corpoErro, data);
      if (url.endsWith("app_sinal_vida")) return new Sincronizador.Resposta(200, "{\"status\":\"ativa\",\"gps_intervalo_s\":20}", data);
      JSONArray conf = new JSONArray(), rec = new JSONArray();
      JSONArray p = a.getJSONArray("p_pontos");
      for (int i = 0; i < p.length(); i++) {
        JSONObject o = p.getJSONObject(i);
        if (o.getLong("t") < 1_000_000_000L) rec.put(new JSONObject().put("id", o.getString("id")).put("motivo", "fora_do_periodo"));
        else conf.put(o.getString("id"));
      }
      return new Sincronizador.Resposta(200, new JSONObject().put("status", "ativa").put("confirmados", conf).put("recusados", rec).put("gps_intervalo_s", 15).toString(), data);
    }
  }

  @Test
  public void filaSobreviveAReaberturaELinhaCortada() throws Exception {
    File d = pasta();
    FilaPontos f = new FilaPontos(d);
    List<FilaPontos.Item> it = f.adicionar(pontos(5, 1_790_000_000_000L));
    assertEquals(5, f.tamanho());
    assertNull(it.get(0).prec);
    // queda no meio de uma gravação: a última linha fica pela metade
    try (FileOutputStream o = new FileOutputStream(new File(d, "pendentes.jsonl"), true)) { o.write("{\"id\":\"x\",\"la".getBytes(StandardCharsets.UTF_8)); }
    FilaPontos g = new FilaPontos(d);
    assertEquals("os 5 pontos gravados continuam lá", 5, g.tamanho());
    assertEquals(1, g.linhasCorrompidas());
    assertEquals(it.get(0).id, g.maisAntigo().id);
    g.remover(Arrays.asList(it.get(0).id, it.get(1).id), null);
    assertEquals(3, new FilaPontos(d).tamanho());
  }

  @Test
  public void enviaEmLotesSoTiraOConfirmado() throws Exception {
    FilaPontos f = new FilaPontos(pasta());
    f.adicionar(pontos(450, 1_790_000_000_000L));
    Falso s = new Falso();
    Sincronizador sync = new Sincronizador("https://x.supabase.co/", "sb_publishable_abc", "11111111-1111-4111-8111-111111111111", "ab".repeat(32), f, s);
    Sincronizador.Resultado r = sync.enviarLote("ok");
    assertEquals(Sincronizador.Tipo.OK, r.tipo);
    assertEquals(200, r.confirmados);
    assertEquals(Integer.valueOf(15), r.intervaloS);
    assertEquals(250, f.tamanho());
    assertEquals("https://x.supabase.co/rest/v1/rpc/app_enviar_posicoes", s.pedidos.get(0).getString("__url"));
    assertEquals("ok", s.pedidos.get(0).getString("p_gps"));
    assertTrue(s.pedidos.get(0).getJSONArray("p_pontos").getJSONObject(0).isNull("prec"));
    assertEquals("chave publicável vai só no apikey", null, s.cabecalhos.get(0).get("Authorization"));
    sync.enviarLote("ok");
    sync.enviarLote("ok");
    assertEquals(0, f.tamanho());
    assertEquals(450, f.enviados());
    assertEquals(3, s.pedidos.size());
  }

  @Test
  public void semInternetNadaSaiDaFila() throws Exception {
    FilaPontos f = new FilaPontos(pasta());
    f.adicionar(pontos(10, 1_790_000_000_000L));
    Falso s = new Falso();
    s.semRede = true;
    Sincronizador.Resultado r = new Sincronizador("https://x.supabase.co", "eyJ.chave.antiga", "d", "s", f, s).enviarLote(null);
    assertEquals(Sincronizador.Tipo.FALHA, r.tipo);
    assertEquals("rede", r.motivo);
    assertEquals(10, f.tamanho());
  }

  @Test
  public void servidorSemConfirmacaoNaoTiraNada() throws Exception {
    FilaPontos f = new FilaPontos(pasta());
    f.adicionar(pontos(3, 1_790_000_000_000L));
    Falso s = new Falso() {
      @Override
      public Sincronizador.Resposta post(String url, Map<String, String> h, String corpo, int tempoMs) {
        return new Sincronizador.Resposta(200, "{\"status\":\"ativa\"}", 0);
      }
    };
    Sincronizador.Resultado r = new Sincronizador("https://x", "k", "d", "s", f, s).enviarLote("ok");
    assertEquals("resposta_sem_confirmacao", r.motivo);
    assertEquals(3, f.tamanho());
  }

  @Test
  public void recusadosSaemEFimDaParticipacaoPara() throws Exception {
    FilaPontos f = new FilaPontos(pasta());
    f.adicionar(pontos(2, 500));   // horário inválido: o servidor recusa de vez
    Falso s = new Falso();
    Sincronizador sync = new Sincronizador("https://x", "k", "d", "s", f, s);
    Sincronizador.Resultado r = sync.enviarLote("ok");
    assertEquals(2, r.recusados);
    assertEquals(0, f.tamanho());
    assertEquals(2, f.recusados());

    f.adicionar(pontos(2, 1_790_000_000_000L));
    s.status = 400;
    s.corpoErro = "{\"code\":\"P0001\",\"message\":\"participante_liberado\"}";
    r = sync.enviarLote("ok");
    assertEquals(Sincronizador.Tipo.FIM, r.tipo);
    assertEquals("liberado", r.motivo);
    assertEquals(2, f.tamanho());
    s.corpoErro = "{\"code\":\"P0001\",\"message\":\"aparelho_app_invalido\"}";
    assertEquals("aparelho", sync.sinal("ok").motivo);
    s.status = 404;
    s.corpoErro = "{\"code\":\"PGRST202\",\"message\":\"Could not find the function public.app_enviar_posicoes\"}";
    r = sync.enviarLote("ok");
    assertEquals(Sincronizador.Tipo.FALHA, r.tipo);
    assertEquals("funcao_ausente", r.motivo);
    s.status = 400;
    s.corpoErro = "{\"message\":\"lote_invalido\"}";
    r = sync.enviarLote("ok");
    assertEquals(Sincronizador.Tipo.OK, r.tipo);
    assertEquals(0, f.tamanho());
  }

  @Test
  public void sinalDeVidaEHoraDoServidor() throws Exception {
    FilaPontos f = new FilaPontos(pasta());
    Falso s = new Falso();
    s.data = System.currentTimeMillis() + 120_000;   // relógio do celular 2 min atrasado
    Sincronizador sync = new Sincronizador("https://x", "k", "d", "s", f, s);
    Sincronizador.Resultado r = sync.sinal("fraco");
    assertEquals(Sincronizador.Tipo.OK, r.tipo);
    assertEquals(Integer.valueOf(20), r.intervaloS);
    assertTrue(Math.abs(sync.desvioRelogioMs() - 120_500) < 2000);
    f.adicionar(pontos(1, 1_790_000_000_000L));
    sync.enviarLote("ok");
    long enviado = s.pedidos.get(1).getJSONArray("p_pontos").getJSONObject(0).getLong("t");
    assertTrue("horário do ponto convertido para o do servidor", Math.abs(enviado - (1_790_000_000_000L + 120_500)) < 2000);
    s.status = 200;
    Falso fim = new Falso() {
      @Override
      public Sincronizador.Resposta post(String url, Map<String, String> h, String corpo, int tempoMs) {
        return new Sincronizador.Resposta(200, "{\"status\":\"removido\"}", 0);
      }
    };
    assertEquals("removido", new Sincronizador("https://x", "k", "d", "s", f, fim).sinal(null).motivo);
    assertFalse(Sincronizador.dataHttp("Fri, 30 Oct 2026 17:33:49 GMT") == 0);
  }
}
