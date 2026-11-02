package br.gbs.busca;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** O filtro nativo decide igual ao da página (casos gerados por android/ferramentas/gerar-casos-filtro.js). */
public class FiltroGpsTest {

  private static Double dbl(JSONArray a, int i) throws Exception { return a.isNull(i) ? null : a.getDouble(i); }

  @Test
  public void mesmasDecisoesQueOFiltroDaPagina() throws Exception {
    InputStream in = getClass().getClassLoader().getResourceAsStream("filtro-casos.json");
    String txt = new Scanner(in, StandardCharsets.UTF_8.name()).useDelimiter("\\A").next();
    JSONArray casos = new JSONArray(txt);
    int leituras = 0, pontos = 0;
    for (int c = 0; c < casos.length(); c++) {
      JSONObject caso = casos.getJSONObject(c);
      FiltroGps.Cfg cfg = new FiltroGps.Cfg();
      if (caso.getJSONObject("cfg").has("intervaloParadoMs")) cfg.intervaloParadoMs = caso.getJSONObject("cfg").getLong("intervaloParadoMs");
      FiltroGps f = new FiltroGps(cfg);
      JSONArray passos = caso.getJSONArray("passos");
      for (int i = 0; i < passos.length(); i++) {
        JSONObject p = passos.getJSONObject(i);
        JSONArray e = p.getJSONArray("e");
        FiltroGps.Resultado r = f.processar(dbl(e, 0), dbl(e, 1), dbl(e, 2), dbl(e, 3), e.getLong(4), e.getLong(5));
        String onde = caso.getString("nome") + " #" + i;
        assertEquals(onde + " motivo", p.getString("m"), r.motivo);
        assertEquals(onde + " rápido", p.getBoolean("r"), r.rapido);
        JSONArray esp = p.getJSONArray("p");
        assertEquals(onde + " qtd pontos", esp.length(), r.pontos.size());
        for (int k = 0; k < esp.length(); k++) {
          JSONArray q = esp.getJSONArray(k);
          FiltroGps.Ponto pt = r.pontos.get(k);
          assertEquals(onde + " lat", q.getDouble(0), pt.lat, 1e-9);
          assertEquals(onde + " lng", q.getDouble(1), pt.lng, 1e-9);
          if (q.isNull(2)) assertNull(onde + " prec", pt.prec);
          else assertEquals(onde + " prec", q.getDouble(2), pt.prec, 1e-9);
          assertEquals(onde + " t", q.getLong(3), pt.t);
          pontos++;
        }
        if (p.isNull("a")) assertNull(onde + " atual", r.atual);
        else assertEquals(onde + " atual t", p.getJSONArray("a").getLong(2), r.atual.t);
        leituras++;
      }
    }
    assertTrue("casos suficientes", leituras > 2000 && pontos > 300);
  }

  @Test
  public void paradoNaoViraTrilhaEAndandoEntra() {
    FiltroGps f = new FiltroGps();
    long t = 1_790_000_000_000L;
    double lat = -25.43, lng = -49.27, m = 1 / 111320.0;
    int aceitosParado = 0;
    for (int i = 0; i < 14; i++) {
      t += 1000;
      aceitosParado += f.processar(lat + (i % 2) * 3 * m, lng, 10.0, 0.0, t, t).pontos.size();
    }
    assertEquals("parado: só o primeiro ponto em 14 s", 1, aceitosParado);
    int andando = 0;
    for (int i = 0; i < 30; i++) {
      t += 1000;
      lat += 1.4 * m;
      andando += f.processar(lat, lng, 6.0, 1.4, t, t).pontos.size();
    }
    assertTrue("andando a 1,4 m/s: um ponto a cada 3 m (~3 s)", andando >= 9 && andando <= 11);
  }
}
