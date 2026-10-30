package br.gbs.busca;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Filtro das leituras do GPS: a mesma regra de public/js/gps.js (Filtro.processar), linha a linha.
 * Nenhuma posição é inventada: o filtro só decide quais leituras reais entram na trilha.
 * A igualdade com o JS é conferida pelo teste FiltroGpsTest (casos gerados a partir do gps.js).
 */
public final class FiltroGps {

  public static final class Cfg {
    public double precisaoTrilhaM = 150;
    public long intervaloRuimMs = 30000;
    public double distanciaMinimaM = 3;
    public double fatorOscilacao = 0.6;
    public double limiteOscilacaoM = 25;
    public int confirmacoesMovimento = 3;
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

  public final Cfg cfg;
  public final Map<String, Integer> contagem = new HashMap<>();
  private final List<Long> offsets = new ArrayList<>();
  private Ancora ancora;
  private long ultimoRuimT;
  private Leitura ultimaLeitura;
  private List<Leitura> suspeitos = new ArrayList<>();
  private int foraDoLimiar;
  private double velRecente;
  private final List<Leitura> recentes = new ArrayList<>();
  private LatLng ancoraMed;
  private final List<Leitura> aceitos = new ArrayList<>();
  private double[] vetorAnterior;

  public FiltroGps() { this(new Cfg()); }
  public FiltroGps(Cfg cfg) { this.cfg = cfg; reiniciar(); }

  public void reiniciar() {
    ancora = null;
    ultimoRuimT = 0;
    ultimaLeitura = null;
    suspeitos = new ArrayList<>();
    foraDoLimiar = 0;
    velRecente = 0;
    recentes.clear();
    ancoraMed = null;
    aceitos.clear();
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
    recentes.add(leitura);
    if (recentes.size() > 3) recentes.remove(0);
    boolean ruim = prec != null && prec > cfg.precisaoTrilhaM;

    if (a == null) {
      if (ruim) {
        if (ultimoRuimT != 0 && t - ultimoRuimT < cfg.intervaloRuimMs) return descartar(leitura, "baixa_precisao");
        ultimoRuimT = t;
        return aceitar(Collections.singletonList(leitura), "primeiro_ponto_impreciso", true);
      }
      return aceitar(Collections.singletonList(leitura), "primeiro_ponto", false);
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
        return aceitar(conf, "salto_confirmado", false);
      }
      return descartar(leitura, "salto_suspeito");
    }
    suspeitos = new ArrayList<>();

    boolean rapido = emMovimentoRapido(vel);
    if (rapido) {
      if (dt < cfg.intervaloMinimoRapidoMs) return descartar(leitura, "intervalo_curto");
      if (d >= cfg.distanciaMinimaRapidoM) return aceitar(Collections.singletonList(leitura), "movimento_rapido", false);
    }

    double maiorPrec = Math.max(p(prec), p(a.prec));
    double limiar = Math.max(cfg.distanciaMinimaM, Math.min(cfg.limiteOscilacaoM, cfg.fatorOscilacao * maiorPrec));
    LatLng med = mediana(recentes);
    LatLng ref = ancoraMed != null ? ancoraMed : new LatLng(a.lat, a.lng);
    double dMed = distancia(ref.lat, ref.lng, med.lat, med.lng);
    boolean porVelocidade = vel != null && vel >= cfg.velocidadeMinimaMs && d >= cfg.distanciaMinimaM;
    boolean gpsParado = vel != null && vel < 0.3 && d < 1.5 * Math.max(maiorPrec, limiar);
    double kLng = Math.cos(ref.lat * Math.PI / 180);
    double[] vet = { (med.lat - ref.lat) * 111320, (med.lng - ref.lng) * 111320 * kLng };
    boolean mesmaDirecao = vetorAnterior == null || (vet[0] * vetorAnterior[0] + vet[1] * vetorAnterior[1])
        > 0.5 * Math.hypot(vet[0], vet[1]) * Math.hypot(vetorAnterior[0], vetorAnterior[1]);
    if (d >= limiar && dMed >= limiar && mesmaDirecao) foraDoLimiar++;
    else foraDoLimiar = d >= limiar && dMed >= limiar ? 1 : 0;
    vetorAnterior = dMed >= limiar ? vet : null;
    boolean movendo = porVelocidade || (!gpsParado && d >= limiar && dMed >= limiar
        && (dMed >= Math.max(maiorPrec, 2 * limiar) || foraDoLimiar >= cfg.confirmacoesMovimento));
    if (dt < cfg.intervaloMinimoMs) return descartar(leitura, "intervalo_curto");
    if (movendo) return aceitar(Collections.singletonList(leitura), "movimento", false);
    if (dt >= cfg.intervaloParadoMs) return aceitar(Collections.singletonList(leitura), "parado_periodico", false);
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
      ancoraMed = recentes.size() >= 3 && !emMovimentoRapido(ultima.vel) ? mediana(recentes) : null;
      foraDoLimiar = 0;
      vetorAnterior = null;
    }
    for (int i = 0; i < leituras.size(); i++) conta(motivo);
    return resultado(ultima, pontos, motivo);
  }

  private Resultado descartar(Leitura leitura, String motivo) {
    conta(motivo);
    return resultado(leitura, new ArrayList<>(), motivo);
  }
}
