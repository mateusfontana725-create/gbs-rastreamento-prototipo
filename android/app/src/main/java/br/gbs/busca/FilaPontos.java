package br.gbs.busca;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.json.JSONObject;

/**
 * Fila dos pontos da trilha guardada no aparelho (memória interna do aplicativo).
 * Um ponto só sai da fila quando o servidor confirma que ele está gravado (ou o recusa de vez).
 * Gravação: cada ponto é acrescentado ao arquivo e sincronizado com o disco antes de seguir (sobrevive a o celular
 * desligar). Remoção: o arquivo é reescrito numa cópia e trocado de uma vez (nunca fica pela metade).
 * Nenhum ponto é descartado por falta de internet, seja qual for o tempo sem sinal.
 */
public final class FilaPontos {

  public static final class Item {
    public final String id;
    public final double lat, lng;
    public final Double prec;
    public final long t;
    public Item(String id, double lat, double lng, Double prec, long t) {
      this.id = id; this.lat = lat; this.lng = lng; this.prec = prec; this.t = t;
    }
    String json() {
      return String.format(Locale.ROOT, "{\"id\":\"%s\",\"lat\":%s,\"lng\":%s,\"prec\":%s,\"t\":%d}",
          id, num(lat), num(lng), prec == null ? "null" : num(prec), t);
    }
    private static String num(double v) {
      String s = Double.toString(v);
      return s.endsWith(".0") ? s.substring(0, s.length() - 2) : s;
    }
  }

  private final File arquivo;
  private final File temporario;
  private final Map<String, Item> itens = new LinkedHashMap<>();
  private long enviados;
  private long recusados;
  private int linhasCorrompidas;

  public FilaPontos(File pasta) throws IOException {
    if (!pasta.isDirectory() && !pasta.mkdirs()) throw new IOException("sem pasta para a fila");
    arquivo = new File(pasta, "pendentes.jsonl");
    temporario = new File(pasta, "pendentes.jsonl.novo");
    carregar();
  }

  private void carregar() throws IOException {
    itens.clear();
    if (!arquivo.exists()) {
      // queda no meio da troca: a cópia nova já estava completa
      if (temporario.exists() && !temporario.renameTo(arquivo)) throw new IOException("falha ao recuperar a fila");
      if (!arquivo.exists()) return;
    }
    try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(arquivo), StandardCharsets.UTF_8))) {
      String linha;
      while ((linha = r.readLine()) != null) {
        if (linha.isEmpty()) continue;
        try {
          JSONObject o = new JSONObject(linha);
          Item it = new Item(o.getString("id"), o.getDouble("lat"), o.getDouble("lng"),
              o.isNull("prec") ? null : o.getDouble("prec"), o.getLong("t"));
          itens.put(it.id, it);
        } catch (Exception e) {
          linhasCorrompidas++;   // só a última linha pode ficar pela metade (queda durante a gravação)
        }
      }
    }
  }

  /** Grava os pontos no aparelho (com id único cada um) e só volta depois de confirmados no disco. */
  public synchronized List<Item> adicionar(List<FiltroGps.Ponto> pontos) throws IOException {
    List<Item> novos = new ArrayList<>();
    StringBuilder sb = new StringBuilder();
    for (FiltroGps.Ponto p : pontos) {
      Item it = new Item(UUID.randomUUID().toString(), p.lat, p.lng, p.prec, p.t);
      novos.add(it);
      sb.append(it.json()).append('\n');
    }
    if (novos.isEmpty()) return novos;
    try (FileOutputStream out = new FileOutputStream(arquivo, true)) {
      out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
      out.getFD().sync();
    }
    for (Item it : novos) itens.put(it.id, it);
    return novos;
  }

  public synchronized List<Item> pendentes(int max) {
    List<Item> l = new ArrayList<>();
    for (Item it : itens.values()) {
      if (l.size() >= max) break;
      l.add(it);
    }
    return l;
  }

  public synchronized int tamanho() { return itens.size(); }
  public synchronized long enviados() { return enviados; }
  public synchronized long recusados() { return recusados; }
  public synchronized int linhasCorrompidas() { return linhasCorrompidas; }

  public synchronized Item maisAntigo() {
    return itens.isEmpty() ? null : itens.values().iterator().next();
  }

  /** Tira da fila os confirmados pelo servidor e os recusados de vez. */
  public synchronized void remover(Collection<String> confirmados, Collection<String> recusadosIds) throws IOException {
    Set<String> sair = new HashSet<>();
    int conf = 0, rec = 0;
    if (confirmados != null) for (String id : confirmados) if (itens.containsKey(id) && sair.add(id)) conf++;
    if (recusadosIds != null) for (String id : recusadosIds) if (itens.containsKey(id) && sair.add(id)) rec++;
    if (sair.isEmpty()) return;
    StringBuilder sb = new StringBuilder();
    for (Item it : itens.values()) if (!sair.contains(it.id)) sb.append(it.json()).append('\n');
    try (FileOutputStream out = new FileOutputStream(temporario, false)) {
      out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
      out.getFD().sync();
    }
    if (!temporario.renameTo(arquivo)) {
      if (!arquivo.delete() || !temporario.renameTo(arquivo)) throw new IOException("falha ao atualizar a fila");
    }
    for (String id : sair) itens.remove(id);
    enviados += conf;
    recusados += rec;
  }

  /** A participação acabou (o servidor não aceita mais nada): apaga a fila do aparelho. */
  public synchronized void limpar() {
    itens.clear();
    //noinspection ResultOfMethodCallIgnored
    arquivo.delete();
    //noinspection ResultOfMethodCallIgnored
    temporario.delete();
  }
}
