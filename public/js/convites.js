/* =====================================================================
 * convites.js — convite de participante por e-mail (migração 044, api/convidar.js)
 *   O responsável cadastra o nome e o e-mail; o servidor envia uma mensagem com o link do civil.html
 *   (com o código do convite, que preenche o nome na página do participante).
 *   Sem o provedor de e-mail configurado no servidor, o painel oferece "Abrir no meu e-mail" e "Copiar link".
 *   Usa a interface window.Painel (militar.js).
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI, P = window.Painel;
  if (!C || !UI || !P) return;
  var el = UI.el;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var MAX_ENVIOS = 5;

  function podeAlterar() { return Boolean(P.podeAlterar && P.podeAlterar()); }
  function linkDo(c) { return P.linkCivil(c.codigo); }

  async function copiar(texto) {
    try { await navigator.clipboard.writeText(texto); UI.aviso('Link copiado.', 'ok'); }
    catch (e) { UI.aviso('Não foi possível copiar. Selecione e copie o link manualmente.', 'erro'); }
  }

  function mailto(c) {
    var op = P.op();
    var assunto = 'Convite para a busca "' + op.codigo + '"';
    var corpo = 'Olá, ' + c.nome + '!\n\nVocê foi convidado para participar da operação de busca "' + op.codigo + '".\n' +
      'Abra o link no celular, toque em COMEÇAR e permita a localização:\n' + linkDo(c) + '\n\nSe você não esperava este convite, ignore esta mensagem.';
    return 'mailto:' + encodeURIComponent(c.email) + '?subject=' + encodeURIComponent(assunto) + '&body=' + encodeURIComponent(corpo);
  }

  // Pede ao servidor para enviar. Devolve { ok } ou { erro, texto }.
  async function enviar(convite) {
    var s = await C.cliente.auth.getSession();
    var token = s && s.data && s.data.session ? s.data.session.access_token : null;
    if (!token) return { erro: 'nao_autenticado', texto: 'Sua sessão expirou. Entre de novo.' };
    var r;
    try {
      r = await fetch('/api/convidar', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ convite: convite.id }) });
    } catch (e) {
      return { erro: 'rede', texto: 'Sem conexão com o servidor. Verifique a internet e tente de novo.' };
    }
    var j = await r.json().catch(function () { return {}; });
    if (r.ok && j.ok) return { ok: true };
    var textos = {
      email_nao_configurado: 'O envio de e-mail ainda não está configurado no servidor.',
      convite_envios_limite: 'Este convite já foi enviado ' + MAX_ENVIOS + ' vezes.',
      operacao_encerrada: 'A operação foi encerrada.',
      falha_envio: 'O provedor de e-mail recusou o envio' + (j.detalhe ? ' (' + j.detalhe + ')' : '') + '.',
      sem_permissao: 'Você não tem permissão para convidar nesta operação.',
      nao_autenticado: 'Sua sessão expirou. Entre de novo.',
    };
    return { erro: j.erro || 'falha', texto: textos[j.erro] || 'Não foi possível enviar o e-mail agora.' };
  }

  function situacao(c) {
    if (c.aceito_em) return { rot: 'Entrou', classe: 'selo-ok', det: 'entrou às ' + C.hora(c.aceito_em, false) };
    if (c.envio_erro) return { rot: 'Falha no envio', classe: 'selo-perigo', det: c.envio_erro };
    if (c.enviado_em) return { rot: 'Enviado', classe: 'selo-neutro', det: 'enviado às ' + C.hora(c.enviado_em, false) + (c.envios > 1 ? ' (' + c.envios + ' envios)' : '') };
    return { rot: 'Não enviado', classe: 'selo-alerta', det: 'ainda não saiu' };
  }

  // Seção para dentro do modal "Convidar". Sozinha: busca a lista e atualiza enquanto estiver na tela.
  function painel() {
    var op = P.op();
    var lista = el('ul', { classe: 'lista-convites' });
    var vazio = el('p', { classe: 'muted', texto: 'Nenhum convite por e-mail ainda.' });
    var aviso = el('div', { classe: 'convite-aviso', hidden: true });
    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var nome = el('input', { classe: 'campo', id: 'conv-nome', maxlength: '40', autocomplete: 'off', placeholder: 'Nome de quem vai participar' });
    var email = el('input', { classe: 'campo', id: 'conv-email', type: 'email', maxlength: '200', autocomplete: 'off', inputmode: 'email', placeholder: 'email@exemplo.com' });
    var btn = el('button', { classe: 'btn btn-escuro', type: 'submit', id: 'conv-enviar', texto: 'Enviar convite' });
    var itens = [], ausente = false, timer = null;

    function mostrarAviso(c, texto) {
      aviso.hidden = false; aviso.innerHTML = '';
      aviso.appendChild(el('p', { texto: texto }));
      aviso.appendChild(el('div', { classe: 'acoes-linha' }, [
        el('a', { classe: 'btn btn-pequeno btn-escuro', href: mailto(c), id: 'conv-mailto', texto: '✉ Abrir no meu e-mail' }),
        el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Copiar link', onclick: function () { copiar(linkDo(c)); } }),
      ]));
    }

    function desenhar() {
      lista.innerHTML = '';
      vazio.hidden = itens.length > 0;
      itens.forEach(function (c) {
        var s = situacao(c);
        var acoes = [];
        if (podeAlterar() && !c.aceito_em) {
          acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: c.enviado_em ? 'Reenviar' : 'Enviar', disabled: c.envios >= MAX_ENVIOS ? true : null, title: c.envios >= MAX_ENVIOS ? 'Limite de ' + MAX_ENVIOS + ' envios' : null,
            onclick: function () { reenviar(c); } }));
        }
        acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Copiar link', onclick: function () { copiar(linkDo(c)); } }));
        if (podeAlterar() && !c.aceito_em) acoes.push(el('button', { classe: 'btn btn-pequeno btn-link', type: 'button', texto: 'Cancelar', onclick: function () { cancelar(c); } }));
        lista.appendChild(el('li', { classe: 'convite-item', 'data-convite': c.id }, [
          el('div', { classe: 'convite-topo' }, [el('strong', { texto: c.nome }), el('span', { classe: 'selo ' + s.classe, texto: s.rot })]),
          el('small', { classe: 'muted', texto: c.email + ' · ' + s.det }),
          el('div', { classe: 'acoes-linha' }, acoes),
        ]));
      });
    }

    async function carregar() {
      if (ausente || !P.op() || P.op().id !== op.id) return;
      try {
        itens = (await C.consultar(C.cliente.from('convites_participante').select('*').eq('operacao_id', op.id).order('criado_em', { ascending: false }).limit(200))) || [];
        desenhar();
      } catch (e) {
        if (/convites_participante/.test(String(e.message)) || e.codigo === 'funcao_ausente') {
          ausente = true; vazio.hidden = false;
          vazio.textContent = 'O convite por e-mail ainda não está no servidor: rode a migração 044 no Supabase.';
          form.hidden = true;
        }
      }
    }

    async function reenviar(c) {
      var r = await enviar(c);
      if (r.ok) { UI.aviso('Convite enviado para ' + c.email + '.', 'ok'); aviso.hidden = true; }
      else { UI.aviso(r.texto, 'erro', 7000); if (r.erro === 'email_nao_configurado' || r.erro === 'falha_envio') mostrarAviso(c, r.texto + ' Envie pelo seu e-mail ou copie o link.'); }
      carregar();
    }

    async function cancelar(c) {
      var ok = await UI.confirmar({ titulo: 'Cancelar o convite de ' + c.nome + '?', texto: 'O link da operação continua valendo para quem já o tem; só o convite (e o nome preenchido) deixa de existir.', ok: 'Cancelar convite', perigo: true, empilhar: true });
      if (!ok) return;
      try { await C.rpc('cancelar_convite_participante', { p_convite: c.id }); UI.aviso('Convite cancelado.', 'ok'); } catch (e) { UI.aviso(e.message, 'erro'); }
      carregar();
    }

    var form = el('form', { classe: 'form-convite', novalidate: true }, [
      el('div', { classe: 'form-grade' }, [
        UI.campo('Nome', nome, { para: 'conv-nome' }),
        UI.campo('E-mail', email, { para: 'conv-email' }),
      ]),
      erro, aviso,
      el('div', { classe: 'acoes-linha' }, [btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true; aviso.hidden = true;
      var n = nome.value.replace(/\s+/g, ' ').trim(), em = email.value.trim().toLowerCase();
      if (n.length < 2) { erro.textContent = 'Informe o nome do participante.'; erro.hidden = false; nome.focus(); return; }
      if (!EMAIL_RE.test(em)) { erro.textContent = 'Confira o e-mail.'; erro.hidden = false; email.focus(); return; }
      btn.disabled = true; btn.textContent = 'Enviando…';
      try {
        var c = await C.rpc('criar_convite_participante', { p_operacao: op.id, p_nome: n, p_email: em });
        var r = await enviar(c);
        if (r.ok) {
          UI.aviso('Convite enviado para ' + em + '.', 'ok');
          nome.value = ''; email.value = ''; nome.focus();
        } else {
          erro.textContent = r.texto; erro.hidden = false;
          if (r.erro === 'email_nao_configurado' || r.erro === 'falha_envio') mostrarAviso(c, 'O convite foi cadastrado, mas o e-mail não saiu. Envie pelo seu e-mail ou copie o link.');
        }
        await carregar();
      } catch (e) {
        erro.textContent = e.message; erro.hidden = false;
      } finally {
        btn.disabled = false; btn.textContent = 'Enviar convite';
      }
    });

    var raiz = el('div', { classe: 'convites-painel' }, [
      el('p', { classe: 'nota', texto: 'A pessoa recebe um e-mail com o link. Ao abrir no celular, o nome já vem preenchido e basta tocar em COMEÇAR.' }),
      podeAlterar() ? form : el('p', { classe: 'muted', texto: 'Operação encerrada: só consulta.' }),
      el('h3', { classe: 'convites-titulo', texto: 'Convidados' }),
      vazio, lista,
    ]);
    carregar();
    // atualiza enquanto a janela está aberta (quem entrou pelo convite, falhas de envio)
    timer = setInterval(function () { if (!document.body.contains(raiz)) { clearInterval(timer); return; } carregar(); }, 12000);
    return raiz;
  }

  window.Convites = { painel: painel, _teste: { situacao: situacao, mailto: mailto } };
})();
