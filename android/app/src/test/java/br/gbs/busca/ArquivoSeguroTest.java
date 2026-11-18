package br.gbs.busca;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ArquivoSeguroTest {

  @Test public void nomeNormalFicaIgual() {
    assertEquals("Trilha-Cb-Souza-20261118-1030.gpx", ArquivoSeguro.nome("Trilha-Cb-Souza-20261118-1030.gpx"));
  }

  @Test public void caminhoEBarrasViramSublinhado() {
    assertEquals("_.._etc_passwd", ArquivoSeguro.nome("/../etc/passwd").replaceFirst("^\\.", ""));
    assertFalse(ArquivoSeguro.nome("../../segredo.gpx").contains("/"));
    assertFalse(ArquivoSeguro.nome("a\\b.gpx").contains("\\"));
  }

  @Test public void semPontoNoComecoENuncaVazio() {
    assertEquals("oculto.gpx", ArquivoSeguro.nome(".oculto.gpx"));
    assertEquals("arquivo.txt", ArquivoSeguro.nome(""));
    assertEquals("arquivo.txt", ArquivoSeguro.nome(null));
    assertEquals("arquivo.txt", ArquivoSeguro.nome("..."));
  }

  @Test public void nomeLongoFicaCom80() {
    StringBuilder b = new StringBuilder();
    for (int i = 0; i < 200; i++) b.append('a');
    b.append(".gpx");
    String n = ArquivoSeguro.nome(b.toString());
    assertEquals(80, n.length());
    assertTrue(n.endsWith(".gpx"));
  }

  @Test public void soTiposDePermitidos() {
    assertEquals("application/gpx+xml", ArquivoSeguro.mime("application/gpx+xml"));
    assertEquals("text/csv", ArquivoSeguro.mime("text/csv"));
    assertEquals(ArquivoSeguro.MIME_PADRAO, ArquivoSeguro.mime("application/vnd.android.package-archive"));
    assertEquals(ArquivoSeguro.MIME_PADRAO, ArquivoSeguro.mime("text/html"));
    assertEquals(ArquivoSeguro.MIME_PADRAO, ArquivoSeguro.mime(null));
  }

  @Test public void tamanhoLimitado() {
    assertFalse(ArquivoSeguro.tamanhoOk(""));
    assertFalse(ArquivoSeguro.tamanhoOk(null));
    assertTrue(ArquivoSeguro.tamanhoOk("QUJD"));
    StringBuilder b = new StringBuilder();
    for (int i = 0; i <= ArquivoSeguro.MAX_BASE64; i++) b.append('A');
    assertFalse(ArquivoSeguro.tamanhoOk(b.toString()));
  }
}
