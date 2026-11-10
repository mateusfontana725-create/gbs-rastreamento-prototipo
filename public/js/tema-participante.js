// Tema da página do participante (escuro ou claro, escolhido no mapa). Roda no <head>, antes da pintura, para a
// tela não piscar. Fica num arquivo próprio porque a política de segurança (CSP) do site bloqueia script embutido.
(function () {
  var v = 'escuro';
  try { if (localStorage.getItem('gbs-civil-tema') === 'claro') v = 'claro'; } catch (e) { /* sem armazenamento: escuro */ }
  document.documentElement.setAttribute('data-tema', v);
})();
