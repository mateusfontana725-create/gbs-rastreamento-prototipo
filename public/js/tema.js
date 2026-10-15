// Tema do painel do responsável (escuro ou claro). Roda no <head>, antes da pintura, para a
// tela não piscar. O padrão é o escuro; a escolha fica no aparelho (Ferramentas → Configurações).
(function () {
  var valor = 'escuro';
  try { if (localStorage.getItem('gbs-painel-tema') === 'claro') valor = 'claro'; } catch (e) { /* sem armazenamento: escuro */ }
  document.documentElement.setAttribute('data-tema', valor);
})();
