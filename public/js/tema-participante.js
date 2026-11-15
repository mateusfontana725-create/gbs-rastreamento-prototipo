// Tema da página do participante: escuro por padrão; o claro é escolha da pessoa (botão do cabeçalho ou Camadas). Roda no <head>, antes da pintura, para a
// tela não piscar. Fica num arquivo próprio porque a política de segurança (CSP) do site bloqueia script embutido.
(function () {
  var v = 'escuro';
  try { if (localStorage.getItem('gbs-tema-participante') === 'claro') v = 'claro'; } catch (e) { /* sem armazenamento: escuro */ }
  document.documentElement.setAttribute('data-tema', v);
})();
