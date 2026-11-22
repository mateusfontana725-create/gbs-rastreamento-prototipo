/* =====================================================================
 * voz-operacao.js — "Preencher por voz" no formulário de Nova operação.
 *   Web Speech API (SpeechRecognition / webkitSpeechRecognition, lang pt-BR) transcreve a fala; o texto (que dá para
 *   corrigir) vai para /api/parse-operacao, que devolve os campos do formulário em JSON. A tela PREENCHE e marca os
 *   campos para conferir; a operação só é criada quando a pessoa clica em "Criar operação". A IA não cria nada.
 *   Sem suporte no navegador (ex.: Firefox), o botão não aparece e o formulário segue igual.
 *   API: window.VozOperacao = { suportado(), montar({ naturezas, aoPreencher(campos) → nº de campos }) → elemento | null }.
 * ===================================================================== */
(function (raiz) {
  'use strict';
  var Reconhecimento = raiz.SpeechRecognition || raiz.webkitSpeechRecognition || null;
  function suportado() { return Boolean(Reconhecimento); }

  async function tokenAtual() {
    try { var s = (await raiz.Comunicacao.cliente.auth.getSession()).data.session; return s ? s.access_token : null; } catch (e) { return null; }
  }

  // Chama o servidor; enquanto espera, avisa que a IA está tentando de novo (o servidor repete sozinho em 503/429).
  async function extrair(texto, naturezas, aviso) {
    var token = await tokenAtual();
    if (!token) return { ok: false, mensagem: 'Entre de novo na sua conta para usar o preenchimento por voz.' };
    var timers = [setTimeout(function () { aviso('A IA está ocupada agora: tentando de novo…'); }, 4000),
      setTimeout(function () { aviso('Ainda tentando de novo (alta demanda na IA)…'); }, 12000),
      setTimeout(function () { aviso('Tentando com um modelo reserva da IA…'); }, 22000)];
    try {
      var r = await fetch('/api/parse-operacao', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ texto: texto, naturezas: naturezas || [] }) });
      var corpo = await r.json().catch(function () { return {}; });
      if (!r.ok) return { ok: false, mensagem: corpo.mensagem || (r.status === 404 ? 'O preenchimento por voz não está instalado neste servidor.' : 'A IA não respondeu agora. Preencha à mão.') };
      return { ok: true, dados: corpo };
    } catch (e) {
      return { ok: false, mensagem: 'Sem conexão com a IA agora. O texto continua aqui; preencha à mão ou tente de novo.' };
    } finally { timers.forEach(clearTimeout); }
  }

  var NOMES = { codigo: 'nome/código', endereco: 'endereço', natureza: 'natureza', solicitante_nome: 'solicitante', descricao: 'observação' };

  function montar(opcoes) {
    if (!suportado()) return null;
    opcoes = opcoes || {};
    var UI = raiz.UI, el = UI.el;
    var rec = null, ouvindo = false, finalTxt = '', erroVoz = false;
    var btnFalar = el('button', { classe: 'btn btn-pequeno voz-btn', type: 'button', id: 'voz-falar', 'aria-pressed': 'false', texto: '🎤 Preencher por voz' });
    var texto = el('textarea', { classe: 'campo voz-texto', id: 'voz-texto', rows: '3', maxlength: '3000', placeholder: 'Fale o que aconteceu: local, natureza, quem acionou, quem está desaparecido… O texto aparece aqui e dá para corrigir.' });
    var estado = el('p', { classe: 'voz-estado muted', role: 'status', 'aria-live': 'polite' });
    var btnPreencher = el('button', { classe: 'btn btn-pequeno btn-escuro', type: 'button', id: 'voz-preencher', texto: 'Preencher o formulário' });
    var painel = el('div', { classe: 'voz-painel', hidden: true }, [texto, el('div', { classe: 'voz-acoes' }, [btnPreencher]), estado]);
    var caixa = el('div', { classe: 'voz-caixa' }, [
      el('div', { classe: 'voz-topo' }, [btnFalar, el('small', { classe: 'muted', texto: 'A IA só preenche; você confere e cria.' })]),
      painel,
    ]);

    function parar() { if (rec && ouvindo) { try { rec.stop(); } catch (e) { /* já parou */ } } }
    function mostrarOuvindo(sim) {
      ouvindo = sim;
      btnFalar.textContent = sim ? '⏹ Parar de ouvir' : '🎤 Falar de novo';
      btnFalar.setAttribute('aria-pressed', sim ? 'true' : 'false');
      btnFalar.classList.toggle('voz-ouvindo', sim);
    }
    function ouvir() {
      painel.hidden = false;
      finalTxt = texto.value.trim() ? texto.value.trim() + ' ' : '';
      rec = new Reconhecimento();
      rec.lang = 'pt-BR';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = function (ev) {
        var parcial = '';
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          var t = ev.results[i][0].transcript;
          if (ev.results[i].isFinal) finalTxt += t.trim() + ' '; else parcial += t;
        }
        texto.value = (finalTxt + parcial).trim();
      };
      rec.onerror = function (ev) {
        erroVoz = true;
        var m = { 'not-allowed': 'O microfone foi bloqueado. Libere o microfone para este site nas permissões do navegador.', 'service-not-allowed': 'O microfone foi bloqueado. Libere o microfone para este site nas permissões do navegador.',
          'no-speech': 'Não ouvi nada. Toque em "Falar de novo" e fale perto do aparelho.', 'audio-capture': 'Nenhum microfone encontrado neste aparelho.', network: 'O reconhecimento de voz precisa de internet.' };
        estado.textContent = m[ev.error] || 'O reconhecimento de voz parou (' + ev.error + ').';
      };
      rec.onend = function () {
        mostrarOuvindo(false);
        if (texto.value.trim() && !erroVoz) enviar();
        else if (!erroVoz) estado.textContent = 'Não ouvi nada. Toque em "Falar de novo" ou digite o relato.';
      };
      erroVoz = false;
      try {
        estado.textContent = '';
        rec.start();
        mostrarOuvindo(true);
        estado.textContent = 'Ouvindo… fale o que aconteceu. Toque em "Parar de ouvir" quando terminar.';
        setTimeout(function () { if (ouvindo && /^Ouvindo/.test(estado.textContent)) estado.textContent = 'Ouvindo…'; }, 6000);
      } catch (e) { estado.textContent = 'Não foi possível ligar o microfone: ' + (e.message || e); }
    }
    async function enviar() {
      var t = texto.value.trim();
      if (!t) { estado.textContent = 'Nada para preencher: fale ou digite o relato.'; return; }
      btnPreencher.disabled = btnFalar.disabled = true;
      estado.textContent = 'A IA está lendo o relato…';
      var r = await extrair(t, opcoes.naturezas, function (m) { estado.textContent = m; });
      btnPreencher.disabled = btnFalar.disabled = false;
      if (!r.ok) { estado.textContent = r.mensagem; return; }
      var campos = (r.dados && r.dados.campos) || {};
      var n = 0;
      try { n = opcoes.aoPreencher ? opcoes.aoPreencher(campos) : 0; } catch (e) { n = 0; }
      var falt = (r.dados.faltando || []).map(function (k) { return NOMES[k] || k; });
      estado.textContent = n
        ? 'Preenchi ' + n + (n > 1 ? ' campos' : ' campo') + ' (marcados em amarelo). Confira tudo e clique em "Criar operação".' + (falt.length ? ' Não foram ditos: ' + falt.join(', ') + '.' : '')
        : 'Não consegui tirar dados do relato. Corrija o texto e toque em "Preencher o formulário", ou preencha à mão.';
    }
    btnFalar.addEventListener('click', function () { if (ouvindo) parar(); else ouvir(); });
    btnPreencher.addEventListener('click', function () { parar(); enviar(); });
    caixa.pararDeOuvir = parar;
    return caixa;
  }

  raiz.VozOperacao = { suportado: suportado, montar: montar };
})(typeof window !== 'undefined' ? window : globalThis);
