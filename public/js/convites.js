/* =====================================================================
 * convites.js — convite de participante por WhatsApp ou e-mail (migrações 044 e 047, api/convidar.js)
 *   O responsável escolhe a categoria (Civil, Bombeiro ou Responsável), digita o nome e o celular (WhatsApp) ou o
 *   e-mail. O link corresponde à categoria: civil → link dos civis; bombeiro → link dos bombeiros; responsável →
 *   painel da operação (pede o login de responsável). Civil e bombeiro levam o código do convite, que preenche o nome.
 *   WhatsApp: abre a conversa com a mensagem pronta (wa.me), sem salvar o contato. E-mail: o servidor envia; sem o
 *   provedor configurado, o painel oferece "Abrir no meu e-mail" e "Copiar link".
 *   Usa a interface window.Painel (militar.js).
 * ===================================================================== */
(function () {
  'use strict';
  var C = window.Comunicacao, UI = window.UI, P = window.Painel;
  if (!C || !UI || !P) return;
  var el = UI.el;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var MAX_ENVIOS = 5;
  var CATEGORIAS = [['civil', 'Civil', 'voluntário, morador'], ['militar', 'Bombeiro', 'militar da operação'], ['responsavel', 'Responsável', 'acompanha pelo painel']];
  var ROTULO = { civil: 'civil', militar: 'bombeiro', responsavel: 'responsável' };

  function podeAlterar() { return Boolean(P.podeAlterar && P.podeAlterar()); }
  function linkDo(c) { return P.linkConvite ? P.linkConvite(c.tipo || 'civil', c.codigo) : P.linkCivil(c.codigo); }

  // Celular brasileiro → só dígitos com 55 (o banco faz a mesma conta)
  function telefoneWhatsApp(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (d.length === 10 || d.length === 11) d = '55' + d;
    return /^\d{12,13}$/.test(d) ? d : null;
  }
  function textoConvite(c) {
    var op = P.op(), link = linkDo(c);
    if (c.tipo === 'responsavel') {
      return 'Olá, ' + c.nome + '! Você foi convidado para acompanhar como responsável a operação "' + op.codigo + '" do Corpo de Bombeiros.\n' +
        'Abra o painel e entre com a sua conta de responsável:\n' + link;
    }
    return 'Olá, ' + c.nome + '! Você foi convidado para participar da operação de busca "' + op.codigo + '" do Corpo de Bombeiros' +
      (c.tipo === 'militar' ? ' (link para bombeiros)' : '') + '.\nAbra o link no celular, toque em COMEÇAR e permita a localização:\n' + link;
  }
  function linkWhatsApp(c) { return 'https://wa.me/' + c.telefone + '?text=' + encodeURIComponent(textoConvite(c)); }

  async function copiar(texto) {
    try { await navigator.clipboard.writeText(texto); UI.aviso('Link copiado.', 'ok'); }
    catch (e) { UI.aviso('Não foi possível copiar. Selecione e copie o link manualmente.', 'erro'); }
  }

  function mailto(c) {
    var op = P.op();
    var assunto = c.tipo === 'responsavel' ? 'Painel da operação "' + op.codigo + '"' : 'Convite para a busca "' + op.codigo + '"';
    return 'mailto:' + encodeURIComponent(c.email) + '?subject=' + encodeURIComponent(assunto) + '&body=' + encodeURIComponent(textoConvite(c) + '\n\nSe você não esperava este convite, ignore esta mensagem.');
  }

  // Pede ao servidor para enviar o e-mail. Devolve { ok } ou { erro, texto }.
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

  // Responsável: o servidor cria o acesso (login = e-mail, senha provisória no e-mail) e inclui na operação.
  // Não passa pelo WhatsApp: o login é o e-mail, então o e-mail é obrigatório.
  async function convidarResponsavel(d) {
    var s = await C.cliente.auth.getSession();
    var token = s && s.data && s.data.session ? s.data.session.access_token : null;
    if (!token) return { erro: 'nao_autenticado', texto: 'Sua sessão expirou. Entre de novo.' };
    var r;
    try {
      r = await fetch('/api/convidar-responsavel', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ operacao_id: P.op().id, nome: d.nome, email: d.email }) });
    } catch (e) {
      return { erro: 'rede', texto: 'Sem conexão com o servidor. Verifique a internet e tente de novo.' };
    }
    var j = await r.json().catch(function () { return {}; });
    if (r.ok && j.ok) return { ok: true, contaCriada: j.conta_criada === true };
    var textos = {
      email_nao_configurado: 'O envio de e-mail ainda não está configurado no servidor. Nada foi criado.',
      email_em_uso: 'Este e-mail já tem uma conta que não é de responsável. Peça a um administrador para verificar.',
      conta_desativada: 'Este responsável está com o acesso desativado. Peça a um administrador para reativar.',
      falha_envio: 'O provedor de e-mail recusou o envio' + (j.detalhe ? ' (' + j.detalhe + ')' : '') + '. Nada foi criado: tente de novo.',
      operacao_encerrada: 'A operação foi encerrada.',
      sem_permissao: 'Você não tem permissão para convidar nesta operação.',
      nao_autenticado: 'Sua sessão expirou. Entre de novo.',
      email_invalido: 'Confira o e-mail.',
      nome_invalido: 'Informe o nome.',
    };
    return { erro: j.erro || 'falha', texto: textos[j.erro] || 'Não foi possível criar o acesso agora. Nada foi criado.' };
  }

  // WhatsApp: abre a conversa com a mensagem pronta e anota no convite que foi aberto
  function abrirWhatsApp(c) {
    window.open(linkWhatsApp(c), '_blank', 'noopener');
    C.rpc('convite_registrar_envio', { p_convite: c.id, p_erro: null }).catch(function () { /* o convite segue valendo */ });
  }

  function situacao(c) {
    if (c.aceito_em) return { rot: 'Entrou', classe: 'selo-ok', det: 'entrou às ' + C.hora(c.aceito_em, false) };
    if (c.envio_erro) return { rot: 'Falha no envio', classe: 'selo-perigo', det: c.envio_erro };
    if (c.enviado_em) return { rot: c.canal === 'whatsapp' ? 'Aberto no WhatsApp' : 'Enviado', classe: 'selo-neutro', det: (c.canal === 'whatsapp' ? 'aberto às ' : 'enviado às ') + C.hora(c.enviado_em, false) + (c.envios > 1 ? ' (' + c.envios + ' vezes)' : '') };
    return { rot: 'Não enviado', classe: 'selo-alerta', det: 'ainda não saiu' };
  }
  function contato(c) { return c.canal === 'whatsapp' ? '+' + c.telefone : c.email; }

  // Seção do modal "Convidar". canal: 'whatsapp' | 'email'. Busca a lista e atualiza enquanto estiver na tela.
  function painel(canal) {
    canal = canal === 'whatsapp' ? 'whatsapp' : 'email';
    var porWhats = canal === 'whatsapp';
    var op = P.op();
    var pre = 'conv-' + (porWhats ? 'w' : 'e') + '-';
    var lista = el('ul', { classe: 'lista-convites' });
    var vazio = el('p', { classe: 'muted', texto: porWhats ? 'Nenhum convite por WhatsApp ainda.' : 'Nenhum convite por e-mail ainda.' });
    var aviso = el('div', { classe: 'convite-aviso', hidden: true });
    var erro = el('p', { classe: 'erro-form', role: 'alert', hidden: true });
    var tipo = 'civil';
    // Responsável não entra por WhatsApp (o login é o e-mail)
    var cats = porWhats ? CATEGORIAS.filter(function (x) { return x[0] !== 'responsavel'; }) : CATEGORIAS;
    var categorias = UI.escolhas(pre + 'tipo', cats.map(function (x) { return { valor: x[0], rotulo: x[1], sub: x[2], marcado: x[0] === 'civil' }; }), function (v) { tipo = v; atualizarTipo(); });
    var ajudaResp = el('p', { classe: 'nota convite-responsavel', hidden: true, texto: 'Cria o acesso de responsável: o login é o e-mail, e a senha provisória vai no próprio e-mail. A pessoa troca a senha no primeiro acesso.' });
    function atualizarTipo() {
      ajudaResp.hidden = porWhats || tipo !== 'responsavel';
      btn.textContent = !porWhats && tipo === 'responsavel' ? 'Criar acesso e enviar' : (porWhats ? 'Abrir no WhatsApp' : 'Enviar convite');
    }
    var nome = el('input', { classe: 'campo', id: pre + 'nome', maxlength: '40', autocomplete: 'off', placeholder: 'Nome de quem vai participar' });
    var contatoIn = porWhats
      ? el('input', { classe: 'campo', id: pre + 'tel', type: 'tel', maxlength: '20', autocomplete: 'off', inputmode: 'tel', placeholder: '(41) 99999-9999' })
      : el('input', { classe: 'campo', id: pre + 'email', type: 'email', maxlength: '200', autocomplete: 'off', inputmode: 'email', placeholder: 'email@exemplo.com' });
    var btn = el('button', { classe: 'btn btn-escuro', type: 'submit', id: pre + 'enviar', texto: porWhats ? 'Abrir no WhatsApp' : 'Enviar convite' });
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
      var meus = itens.filter(function (c) { return (c.canal || 'email') === canal; });
      vazio.hidden = meus.length > 0;
      meus.forEach(function (c) {
        var s = situacao(c);
        var acoes = [];
        if (podeAlterar() && !c.aceito_em && c.tipo !== 'responsavel') {
          acoes.push(porWhats
            ? el('button', { classe: 'btn btn-pequeno', type: 'button', texto: c.enviado_em ? 'Abrir de novo' : 'Abrir no WhatsApp', onclick: function () { abrirWhatsApp(c); setTimeout(carregar, 800); } })
            : el('button', { classe: 'btn btn-pequeno', type: 'button', texto: c.enviado_em ? 'Reenviar' : 'Enviar', disabled: c.envios >= MAX_ENVIOS ? true : null,
              title: c.envios >= MAX_ENVIOS ? 'Limite de ' + MAX_ENVIOS + ' envios' : null, onclick: function () { reenviar(c); } }));
        }
        if (c.tipo !== 'responsavel') acoes.push(el('button', { classe: 'btn btn-pequeno', type: 'button', texto: 'Copiar link', onclick: function () { copiar(linkDo(c)); } }));
        if (podeAlterar() && !c.aceito_em) acoes.push(el('button', { classe: 'btn btn-pequeno btn-link', type: 'button', texto: 'Cancelar', onclick: function () { cancelar(c); } }));
        lista.appendChild(el('li', { classe: 'convite-item', 'data-convite': c.id }, [
          el('div', { classe: 'convite-topo' }, [el('strong', { texto: c.nome }), el('span', { classe: 'selo selo-neutro', texto: ROTULO[c.tipo || 'civil'] }), el('span', { classe: 'selo ' + s.classe, texto: s.rot })]),
          el('small', { classe: 'muted', texto: contato(c) + ' · ' + s.det }),
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
          vazio.textContent = 'O convite ainda não está no servidor: rode as migrações 044 e 047 no Supabase.';
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
      UI.campo('Categoria', categorias, { dica: 'O link enviado corresponde à categoria: civis e bombeiros entram pela página do participante; responsável, pelo painel (com login).' }),
      el('div', { classe: 'form-grade' }, [
        UI.campo('Nome', nome, { para: pre + 'nome' }),
        UI.campo(porWhats ? 'Celular (WhatsApp)' : 'E-mail', contatoIn, { para: contatoIn.id, ajuda: porWhats ? 'Com DDD. Não precisa salvar o contato.' : null }),
      ]),
      ajudaResp, erro, aviso,
      el('div', { classe: 'acoes-linha' }, [btn]),
    ]);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      erro.hidden = true; aviso.hidden = true;
      var n = nome.value.replace(/\s+/g, ' ').trim();
      if (n.length < 2) { erro.textContent = 'Informe o nome.'; erro.hidden = false; nome.focus(); return; }
      var dados = { nome: n, tipo: tipo, canal: canal };
      if (porWhats) {
        var tel = telefoneWhatsApp(contatoIn.value);
        if (!tel) { erro.textContent = 'Confira o celular (DDD e número).'; erro.hidden = false; contatoIn.focus(); return; }
        dados.telefone = tel;
      } else {
        var em = contatoIn.value.trim().toLowerCase();
        if (!EMAIL_RE.test(em)) { erro.textContent = 'Confira o e-mail.'; erro.hidden = false; contatoIn.focus(); return; }
        dados.email = em;
      }
      // a janela do WhatsApp precisa abrir no clique (senão o navegador bloqueia): abre já e depois põe o endereço
      var janela = porWhats ? window.open('', '_blank') : null;
      btn.disabled = true;
      try {
        if (!porWhats && tipo === 'responsavel') {
          var rr = await convidarResponsavel(dados);
          if (rr.ok) {
            UI.aviso(rr.contaCriada
              ? 'Acesso criado para ' + dados.email + '. O login é o e-mail; a senha provisória foi enviada junto.'
              : dados.email + ' já tinha conta de responsável: foi incluído na operação e recebeu o link.', 'ok', 7000);
            nome.value = ''; contatoIn.value = ''; nome.focus();
          } else {
            erro.textContent = rr.texto; erro.hidden = false;
          }
          await carregar();
          return;
        }
        var c = await C.rpc('criar_convite', { p_operacao: op.id, p_dados: dados });
        if (porWhats) {
          if (janela) { try { janela.opener = null; janela.location.href = linkWhatsApp(c); } catch (x) { window.open(linkWhatsApp(c), '_blank', 'noopener'); } }
          else window.open(linkWhatsApp(c), '_blank', 'noopener');
          C.rpc('convite_registrar_envio', { p_convite: c.id, p_erro: null }).catch(function () { /* segue */ });
          UI.aviso('Conversa do WhatsApp aberta com a mensagem e o link de ' + ROTULO[tipo] + '. Toque em enviar lá.', 'ok', 7000);
          nome.value = ''; contatoIn.value = ''; nome.focus();
        } else {
          var r = await enviar(c);
          if (r.ok) { UI.aviso('Convite enviado para ' + dados.email + '.', 'ok'); nome.value = ''; contatoIn.value = ''; nome.focus(); }
          else {
            erro.textContent = r.texto; erro.hidden = false;
            if (r.erro === 'email_nao_configurado' || r.erro === 'falha_envio') mostrarAviso(c, 'O convite foi cadastrado, mas o e-mail não saiu. Envie pelo seu e-mail ou copie o link.');
          }
        }
        await carregar();
      } catch (e) {
        if (janela) try { janela.close(); } catch (x) { /* ignora */ }
        erro.textContent = e.codigo === 'funcao_ausente' ? 'Rode a migração 047 no Supabase para convidar por categoria e pelo WhatsApp.' : e.message; erro.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });

    var raiz = el('div', { classe: 'convites-painel' }, [
      el('p', { classe: 'nota', texto: porWhats
        ? 'Abre a conversa do WhatsApp com a mensagem e o link da categoria, sem precisar salvar o contato. Para civis e bombeiros o nome já vem preenchido na página. Responsável não entra por WhatsApp: use a aba E-mail.'
        : 'A pessoa recebe um e-mail com o link da categoria. Para civis e bombeiros, o nome já vem preenchido e basta tocar em COMEÇAR.' }),
      podeAlterar() ? form : el('p', { classe: 'muted', texto: 'Operação encerrada: só consulta.' }),
      el('h3', { classe: 'convites-titulo', texto: 'Convidados' }),
      vazio, lista,
    ]);
    atualizarTipo();
    carregar();
    // atualiza enquanto a janela está aberta (quem entrou pelo convite, falhas de envio)
    timer = setInterval(function () { if (!document.body.contains(raiz)) { clearInterval(timer); return; } carregar(); }, 12000);
    return raiz;
  }

  window.Convites = { painel: painel, _teste: { situacao: situacao, mailto: mailto, telefoneWhatsApp: telefoneWhatsApp, textoConvite: textoConvite } };
})();
