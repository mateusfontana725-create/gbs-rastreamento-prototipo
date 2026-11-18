package br.gbs.busca;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Validação do que a página manda para o aplicativo guardar ou compartilhar (exportação da trilha): nome sem caracteres
 * perigosos (nada de pasta ou caminho) e só tipos de arquivo de mapa e planilha. Classe simples, sem Android, testada em
 * ArquivoSeguroTest.
 */
final class ArquivoSeguro {

  static final int MAX_BASE64 = 16 * 1024 * 1024;
  static final String MIME_PADRAO = "application/octet-stream";
  private static final Set<String> MIMES = new HashSet<>(Arrays.asList(
      "application/gpx+xml", "application/vnd.google-earth.kml+xml", "application/geo+json", "application/json",
      "application/xml", "text/xml", "text/csv", "text/plain"));

  private ArquivoSeguro() { }

  /** Nome limpo: só letras, números, ponto, espaço, hífen e sublinhado; sem ponto no começo; até 80 caracteres. */
  static String nome(String bruto) {
    String n = bruto == null ? "" : bruto.replaceAll("[^A-Za-z0-9._ -]", "_").trim();
    while (n.startsWith(".")) n = n.substring(1);
    if (n.length() > 80) n = n.substring(n.length() - 80);
    return n.isEmpty() ? "arquivo.txt" : n;
  }

  /** O tipo pedido, se for um dos permitidos; senão, genérico. */
  static String mime(String pedido) {
    return pedido != null && MIMES.contains(pedido) ? pedido : MIME_PADRAO;
  }

  static boolean tamanhoOk(String base64) {
    return base64 != null && !base64.isEmpty() && base64.length() <= MAX_BASE64;
  }
}
