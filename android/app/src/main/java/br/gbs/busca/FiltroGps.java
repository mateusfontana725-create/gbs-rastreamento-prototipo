package br.gbs.busca;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Filtro das leituras do GPS: a mesma regra de public/js/gps.js (Filtro.processar), linha a linha.
 * Andando, cada ponto é uma leitura real; parado, o ponto é o centro (mediana) das leituras reais no lugar.
 * A igualdade com o JS é conferida pelo teste FiltroGpsTest (casos gerados a partir do gps.js).
 */
public final class FiltroGps {

  public static final class Cfg {
    public double precisaoTrilhaM = 150;
    public long intervaloRuimMs = 30000;
    public double distanciaMinimaM = 3;
    public double fatorOscilacao = 1;
    public double limiteOscilacaoM = 25;
    public double precisaoVelocidadeM = 20;
    public int confirmacoesMovimento = 3;
    public double fatorDispersao = 3;
    public double fatorSaida = 1.5;
    public double velocidadePeMs = 3;
    public long confirmacaoPuloMs = 30000;
    public int janelaParado = 60;
    public double fatorPasso = 0.8;
    public double passoMaxM = 20;
    public long janelaParadaMs = 20000;
    public double fatorParada = 0.4;
    public int confirmacoesParada = 3;
    public double velocidadeMinimaMs = 0.7;
    public long intervaloMinimoMs = 2000;
    public double velocidadeRapidaMs = 5;
    public long intervaloMinimoRapidoMs = 1000;
    public double distanciaMinimaRapidoM = 8;
    public long intervaloParadoMs = 15000;
    public double velocidadeBaseMs = 12;
    public double fatorVelocidade = 2.5;
    public double velocidadeAbsurdaMs = 70;
    public int confirmacoesSalto = 2;
    public long idadeMaximaMs = 30000;
  }

  /** Leitura válida do aparelho. prec e vel podem ser nulos. */
  public static final class Leitura {
    public final double lat, lng;
    public final Double prec, vel;
    public final long t, recebidaEm;
    Leitura(double lat, double lng, Double prec, long t, Double vel, long recebidaEm) {
      this.lat = lat; this.lng = lng; this.prec = prec; this.t = t; this.vel = vel; this.recebidaEm = recebidaEm;
    }
  }

  /** Ponto que entra na trilha (arredondado como no JS). */
  public static final class Ponto {
    public final double lat, lng;
    public final Double prec;
    public final long t;
    Ponto(double lat, double lng, Double prec, long t) { this.lat = lat; this.lng = lng; this.prec = prec; this.t = t; }
  }

  public static final class Resultado {
    public final Leitura atual;
    public final List<Ponto> pontos;
    public final String motivo;
    public final boolean rapido;
    Resultado(Leitura atual, List<Ponto> pontos, String motivo, boolean rapido) {
      this.atual = atual; this.pontos = pontos; this.motivo = motivo; this.rapido = rapido;
    }
  }

  private static final class Ancora {
    final double lat, lng; final Double prec; final long t;
    Ancora(double lat, double lng, Double prec, long t) { this.lat = lat; this.lng = lng; this.prec = prec; this.t = t; }
  }

  private static final class LatLng {
    final double lat, lng;
    LatLng(double lat, double lng) { this.lat = lat; this.lng = lng; }
  }

  /** Estado parado: leituras no lugar, centro (mediana) e a saída em análise. */
  private static final class Parado {
    List<Leitura> leituras;
    LatLng centro;
    List<Leitura> fora = new ArrayList<>();
    long ultimoDentroT;
    Leitura ultimaLeitura, anterior;
  }

  public final Cfg cfg;
  public final Map<String, Integer> contagem = new HashMap<>();
  private final List<Long> offsets = new ArrayList<>();
  private Ancora ancora;
  private long ultimoRuimT;
  private Leitura ultimaLeitura;
  private List<Leitura> suspeitos = new ArrayList<>();
  private double velRecente;
  private final List<Leitura> janela = new ArrayList<>();
  private final List<Leitura> aceitos = new ArrayList<>();
  private String estado;
  private Parado parado;
  private int paradaSeguida;

  public FiltroGps() { this(new Cfg()); }
  public FiltroGps(Cfg cfg) { this.cfg = cfg; reiniciar(); }

  public void reiniciar() {
    ancora = null;
    ultimoRuimT = 0;
    ultimaLeitura = null;
    suspeitos = new ArrayList<>();
    velRecente = 0;
    janela.clear();
    aceitos.clear();
    estado = null;
    parado = null;
    paradaSeguida = 0;
  }

  static double distancia(double lat1, double lng1, double lat2, double lng2) {
    double r = 6371000, k = Math.PI / 180;
    double dLat = (lat2 - lat1) * k, dLng = (lng2 - lng1) * k;
    double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
        + Math.cos(lat1 * k) * Math.cos(lat2 * k) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  private static boolean finito(Double v) { return v != null && !v.isNaN() && !v.isInfinite(); }
  private static double p(Double v) { return v == null ? 0 : v; }

  private static double med1(double[] v) {
    double[] c = v.clone();
    Arrays.sort(c);
    return c[c.length / 2];
  }

  private static LatLng mediana(List<Leitura> ls) {
    double[] la = new double[ls.size()], ln = new double[ls.size()];
    for (int i = 0; i < ls.size(); i++) { la[i] = ls.get(i).lat; ln[i] = ls.get(i).lng; }
    return new LatLng(med1(la), med1(ln));
  }

  private static double precMediana(List<Leitura> ls) {
    double[] v = new double[ls.size()];
    for (int i = 0; i < ls.size(); i++) v[i] = p(ls.get(i).prec);
    return med1(v);
  }

  private static <T> List<T> ultimas(List<T> ls, int n) { return new ArrayList<>(ls.subList(Math.max(0, ls.size() - n), ls.size())); }

  private void conta(String motivo) {
    Integer n = contagem.get(motivo);
    contagem.put(motivo, n == null ? 1 : n + 1);
  }

  double velocidadeMaxima(Double vel) {
    double v = Math.max(Math.max(cfg.velocidadeBaseMs, cfg.fatorVelocidade * velRecente), vel != null ? vel * 1.5 + 5 : 0);
    return Math.min(v, cfg.velocidadeAbsurdaMs);
  }

  boolean emMovimentoRapido(Double vel) {
    if (vel != null) return vel >= cfg.velocidadeRapidaMs;
    return velRecente >= cfg.velocidadeRapidaMs && retidao() >= 0.7;
  }

  private double retidao() {
    if (aceitos.size() < 3) return 0;
    double soma = 0;
    for (int i = 1; i < aceitos.size(); i++) {
      soma += distancia(aceitos.get(i - 1).lat, aceitos.get(i - 1).lng, aceitos.get(i).lat, aceitos.get(i).lng);
    }
    Leitura a = aceitos.get(0), b = aceitos.get(aceitos.size() - 1);
    return soma > 0 ? distancia(a.lat, a.lng, b.lat, b.lng) / soma : 0;
  }

  /**
   * lat/lng em graus; precisao e velocidade podem ser nulas; timestamp em ms (0 = sem horário); agora em ms.
   */
  public Resultado processar(Double latIn, Double lngIn, Double precisao, Double velocidade, long timestamp, long agora) {
    if (!finito(latIn) || !finito(lngIn)) return invalida();
    double lat = latIn, lng = lngIn;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat == 0 && lng == 0)) return invalida();
    long t;
    if (timestamp != 0 && Math.abs(timestamp - agora) < 24L * 3600 * 1000) {
      offsets.add(agora - timestamp);
      if (offsets.size() > 3) offsets.remove(0);
      long minO = Collections.min(offsets), maxO = Collections.max(offsets);
      long desvio = offsets.size() == 3 && maxO - minO < 5000 && Math.abs(minO) > 5000 ? minO : 0;
      t = Math.min(timestamp + desvio, agora);
    } else {
      t = agora;
    }
    Double prec = finito(precisao) ? precisao : null;
    if (prec != null && prec < 0) prec = null;
    Double vel = finito(velocidade) ? velocidade : null;
    if (vel != null && (vel < 0 || vel > cfg.velocidadeAbsurdaMs)) vel = null;
    Leitura leitura = new Leitura(lat, lng, prec, t, vel, agora);

    if (agora - t > cfg.idadeMaximaMs) { conta("leitura_antiga"); return resultado(null, new ArrayList<>(), "leitura_antiga"); }
    Leitura u = ultimaLeitura;
    if (u != null && u.t == t && u.lat == lat && u.lng == lng) { conta("duplicada"); return resultado(null, new ArrayList<>(), "duplicada"); }
    Ancora a = ancora;
    if (a != null && t <= a.t) { conta("fora_de_ordem"); return resultado(null, new ArrayList<>(), "fora_de_ordem"); }
    ultimaLeitura = leitura;
    if (vel != null) velRecente = 0.5 * velRecente + 0.5 * vel;
    boolean ruim = prec != null && prec > cfg.precisaoTrilhaM;
    if (!ruim) {
      janela.add(leitura);
      while (janela.size() > 60 || t - janela.get(0).t > 30000) janela.remove(0);
    }

    if (a == null) {
      if (ruim) {
        if (ultimoRuimT != 0 && t - ultimoRuimT < cfg.intervaloRuimMs) return descartar(leitura, "baixa_precisao");
        ultimoRuimT = t;
        return aceitar(Collections.singletonList(leitura), "primeiro_ponto_impreciso", true);
      }
      Resultado r0 = aceitar(Collections.singletonList(leitura), "primeiro_ponto", false);
      ficarParado(Collections.singletonList(leitura));
      return r0;
    }

    long dt = t - a.t;
    double d = distancia(a.lat, a.lng, lat, lng);

    if (ruim) {
      if (t - Math.max(ultimoRuimT, a.t) < cfg.intervaloRuimMs) return descartar(leitura, "baixa_precisao");
      ultimoRuimT = t;
      return aceitar(Collections.singletonList(leitura), "aproximado", true);
    }

    double incerteza = p(prec) + p(a.prec) + 20;
    double vImplicita = d / Math.max(dt / 1000.0, 0.5);
    if (d > incerteza && vImplicita > velocidadeMaxima(vel)) {
      List<Leitura> s = suspeitos;
      Leitura ult = s.isEmpty() ? null : s.get(s.size() - 1);
      if (ult != null) {
        double ds = distancia(ult.lat, ult.lng, lat, lng);
        double dts = Math.max((t - ult.t) / 1000.0, 0.5);
        boolean coerente = ds <= p(prec) + p(ult.prec) + 20 || ds / dts <= cfg.velocidadeAbsurdaMs;
        if (!coerente) s.clear();
      }
      s.add(leitura);
      if (s.size() >= cfg.confirmacoesSalto) {
        List<Leitura> conf = new ArrayList<>(s);
        suspeitos = new ArrayList<>();
        Leitura ultimo = conf.get(conf.size() - 1), primeiro = conf.get(0);
        double dtc = Math.max((ultimo.t - primeiro.t) / 1000.0, 0.5);
        velRecente = Math.max(velRecente, distancia(primeiro.lat, primeiro.lng, ultimo.lat, ultimo.lng) / dtc);
        andar();
        return aceitar(conf, "salto_confirmado", false);
      }
      return descartar(leitura, "salto_suspeito");
    }
    suspeitos = new ArrayList<>();

    boolean rapido = emMovimentoRapido(vel);
    if (rapido) {
      if (dt < cfg.intervaloMinimoRapidoMs) return descartar(leitura, "intervalo_curto");
      if (d >= cfg.distanciaMinimaRapidoM) { andar(); return aceitar(Collections.singletonList(leitura), "movimento_rapido", false); }
    }
    return "andando".equals(estado) ? processarAndando(leitura) : processarParado(leitura);
  }

  // Parado e andando: ver os comentários em public/js/gps.js (mesmos nomes e a mesma ordem).
  private void ficarParado(List<Leitura> leituras) {
    Parado P = new Parado();
    P.leituras = ultimas(leituras, cfg.janelaParado);
    P.centro = mediana(P.leituras);
    P.ultimoDentroT = P.leituras.get(P.leituras.size() - 1).t;
    P.ultimaLeitura = P.leituras.get(P.leituras.size() - 1);
    estado = "parado";
    parado = P;
  }

  private void andar() { estado = "andando"; parado = null; paradaSeguida = 0; }

  private double raioParado() {
    Parado P = parado;
    double r = cfg.fatorOscilacao * precMediana(P.leituras);
    if (P.leituras.size() >= 10) {
      double[] ds = new double[P.leituras.size()];
      for (int i = 0; i < ds.length; i++) ds[i] = distancia(P.centro.lat, P.centro.lng, P.leituras.get(i).lat, P.leituras.get(i).lng);
      r = Math.max(r, cfg.fatorDispersao * med1(ds));
    }
    return Math.max(cfg.distanciaMinimaM, Math.min(cfg.limiteOscilacaoM, r));
  }

  private boolean velocidadeConfirma(boolean minima) {
    List<Leitura> j = ultimas(janela, 3);
    if (j.size() != 3) return false;
    for (Leitura l : j) {
      if (l.vel == null || p(l.prec) > cfg.precisaoVelocidadeM) return false;
      if (minima ? l.vel < cfg.velocidadeMinimaMs : l.vel >= 0.3) return false;
    }
    return true;
  }

  private Leitura centro(Parado P, Leitura leitura) {
    return new Leitura(P.centro.lat, P.centro.lng, precMediana(P.leituras), leitura.t, leitura.vel, leitura.recebidaEm);
  }

  private Resultado processarParado(Leitura leitura) {
    Parado P = parado;
    Resultado r = processarParadoLeitura(leitura);
    if (parado == P) P.ultimaLeitura = leitura;
    return r;
  }

  private Resultado processarParadoLeitura(Leitura leitura) {
    Parado P = parado;
    double R = raioParado();
    if (distancia(P.centro.lat, P.centro.lng, leitura.lat, leitura.lng) <= R) {
      P.fora = new ArrayList<>();
      P.leituras.add(leitura);
      if (P.leituras.size() > cfg.janelaParado) P.leituras.remove(0);
      P.centro = mediana(P.leituras);
      P.ultimoDentroT = leitura.t;
      List<Leitura> saida = tendencia();
      if (saida != null) { andar(); return aceitar(saida, "movimento", false); }
      return confirmarParado(leitura, "oscilacao_parado");
    }
    if (P.fora.isEmpty()) P.anterior = P.ultimaLeitura;
    P.fora.add(leitura);
    Leitura f0 = P.fora.get(0);
    double salto0 = distancia(P.centro.lat, P.centro.lng, f0.lat, f0.lng);
    double precMed = precMediana(P.leituras);
    double permitido = R + cfg.velocidadePeMs * Math.max(1, (f0.t - P.ultimoDentroT) / 1000.0) + 0.5 * precMed;
    Leitura ant = P.anterior;
    boolean degrau = ant != null && distancia(ant.lat, ant.lng, f0.lat, f0.lng)
        > cfg.velocidadePeMs * Math.max(1, (f0.t - ant.t) / 1000.0) + Math.max(cfg.distanciaMinimaM, 0.5 * precMed);
    LatLng med = mediana(ultimas(P.fora, 3));
    double dMed = distancia(P.centro.lat, P.centro.lng, med.lat, med.lng);
    boolean pulo = (salto0 > permitido || degrau) && distancia(f0.lat, f0.lng, med.lat, med.lng) < R;
    if (pulo) {
      if (leitura.t - f0.t >= cfg.confirmacaoPuloMs) {
        ficarParado(P.fora);
        return aceitar(Collections.singletonList(centro(parado, leitura)), "salto_confirmado", false);
      }
      return confirmarParado(leitura, "pulo_parado");
    }
    boolean porVel = velocidadeConfirma(true);
    if (P.fora.size() >= (porVel ? 2 : cfg.confirmacoesMovimento) && dMed >= (porVel ? 1 : cfg.fatorSaida) * R
        && leitura.t - ancora.t >= cfg.intervaloMinimoMs) {
      List<Leitura> saida = espacar(P.fora);
      andar();
      return aceitar(saida, "movimento", false);
    }
    return confirmarParado(leitura, "oscilacao_parado");
  }

  private List<Leitura> tendencia() {
    List<Leitura> ls = parado.leituras;
    Leitura ult = ls.get(ls.size() - 1);
    boolean porVel = velocidadeConfirma(true);
    List<Leitura> w = new ArrayList<>();
    for (Leitura l : ls) if (ult.t - l.t <= cfg.janelaParadaMs) w.add(l);
    if (w.size() < (porVel ? 3 : 6) || ult.t - w.get(0).t < (porVel ? 2000 : cfg.janelaParadaMs * 0.5)
        || ult.t - ancora.t < cfg.intervaloMinimoMs) return null;
    int n = w.size() / 3;
    LatLng a = mediana(w.subList(0, n)), b = mediana(w.subList(w.size() - n, w.size()));
    double rPrec = Math.max(cfg.distanciaMinimaM, Math.min(cfg.limiteOscilacaoM, cfg.fatorOscilacao * precMediana(w)));
    if (distancia(a.lat, a.lng, b.lat, b.lng) < (porVel ? 1 : cfg.fatorSaida) * rPrec) return null;
    return espacar(w.subList(n, w.size()));
  }

  private Resultado confirmarParado(Leitura leitura, String motivo) {
    Parado P = parado;
    long dtA = leitura.t - ancora.t;
    if (dtA >= cfg.intervaloParadoMs && (P.fora.isEmpty() || dtA >= 2 * cfg.intervaloParadoMs)) {
      return aceitar(Collections.singletonList(centro(P, leitura)), "parado_periodico", false);
    }
    return descartar(leitura, motivo);
  }

  private double passo(Double prec) {
    return Math.max(cfg.distanciaMinimaM, Math.min(cfg.passoMaxM, cfg.fatorPasso * p(prec)));
  }

  private List<Leitura> espacar(List<Leitura> ls) {
    List<Leitura> out = new ArrayList<>();
    double refLat = ancora.lat, refLng = ancora.lng;
    long refT = ancora.t;
    for (int i = 0; i < ls.size(); i++) {
      Leitura l = ls.get(i);
      if (l.t - refT < cfg.intervaloMinimoMs) continue;
      if (i == ls.size() - 1 || distancia(refLat, refLng, l.lat, l.lng) >= passo(l.prec)) {
        out.add(l); refLat = l.lat; refLng = l.lng; refT = l.t;
      }
    }
    if (out.isEmpty()) out.add(ls.get(ls.size() - 1));
    return out;
  }

  private boolean parou() {
    Leitura ult = janela.get(janela.size() - 1);
    List<Leitura> w = new ArrayList<>();
    for (Leitura l : janela) if (ult.t - l.t <= cfg.janelaParadaMs) w.add(l);
    if (w.size() < 6 || ult.t - w.get(0).t < cfg.janelaParadaMs * 0.75) return false;
    int n = w.size() / 3;
    LatLng a = mediana(w.subList(0, n)), b = mediana(w.subList(w.size() - n, w.size()));
    return distancia(a.lat, a.lng, b.lat, b.lng) < Math.max(cfg.distanciaMinimaM, cfg.fatorParada * precMediana(w));
  }

  private Resultado processarAndando(Leitura leitura) {
    paradaSeguida = parou() ? paradaSeguida + 1 : 0;
    if (paradaSeguida >= cfg.confirmacoesParada || velocidadeConfirma(false)) {
      ficarParado(ultimas(janela, 3));
      return confirmarParado(leitura, "oscilacao_parado");
    }
    if (leitura.t - ancora.t < cfg.intervaloMinimoMs) return descartar(leitura, "intervalo_curto");
    LatLng med = mediana(ultimas(janela, 3));
    if (distancia(ancora.lat, ancora.lng, med.lat, med.lng) >= passo(leitura.prec)) return aceitar(Collections.singletonList(leitura), "movimento", false);
    if (leitura.t - ancora.t >= cfg.intervaloParadoMs) return aceitar(Collections.singletonList(leitura), "parado_periodico", false);
    return descartar(leitura, "oscilacao_parado");
  }

  private Resultado invalida() {
    conta("coordenada_invalida");
    return resultado(null, new ArrayList<>(), "coordenada_invalida");
  }

  private Resultado resultado(Leitura atual, List<Ponto> pontos, String motivo) {
    return new Resultado(atual, pontos, motivo, emMovimentoRapido(null));
  }

  private Resultado aceitar(List<Leitura> leituras, String motivo, boolean aproximado) {
    List<Ponto> pontos = new ArrayList<>();
    for (Leitura l : leituras) {
      pontos.add(new Ponto(Math.round(l.lat * 1e7) / 1e7, Math.round(l.lng * 1e7) / 1e7,
          l.prec == null ? null : Math.round(l.prec * 10) / 10.0, l.t));
    }
    Leitura ultima = leituras.get(leituras.size() - 1);
    if (!aproximado) {
      aceitos.addAll(leituras);
      while (aceitos.size() > 4) aceitos.remove(0);
      if (ultima.vel == null && aceitos.size() >= 2) {
        Leitura p0 = aceitos.get(0);
        double dtA = (ultima.t - p0.t) / 1000.0;
        if (dtA > 0) velRecente = 0.5 * velRecente + 0.5 * (distancia(p0.lat, p0.lng, ultima.lat, ultima.lng) / dtA);
      }
      if ("parado_periodico".equals(motivo)) velRecente *= 0.3;
      ancora = new Ancora(ultima.lat, ultima.lng, ultima.prec, ultima.t);
    }
    for (int i = 0; i < leituras.size(); i++) conta(motivo);
    return resultado(ultima, pontos, motivo);
  }

  private Resultado descartar(Leitura leitura, String motivo) {
    conta(motivo);
    return resultado(leitura, new ArrayList<>(), motivo);
  }
}
