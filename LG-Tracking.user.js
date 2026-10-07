// ==UserScript==
// @name         Mope 1v1's — Loader
// @namespace    https://mope-1v1s.local/
// @version      1.1.0
// @description  Loader do Mope 1v1's. Busca automaticamente a versão atual do núcleo oficial.
// @author       Mope 1v1's
// @homepageURL  https://github.com/cute-hardware/mope-1v1s
// @supportURL   https://github.com/cute-hardware/mope-1v1s/issues
// @updateURL    https://raw.githubusercontent.com/cute-hardware/mope-1v1s/main/LG-Tracking.user.js
// @downloadURL  https://raw.githubusercontent.com/cute-hardware/mope-1v1s/main/LG-Tracking.user.js
// @match        https://mope.io/*
// @match        https://www.mope.io/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @sandbox      raw
// @noframes
// ==/UserScript==

/*
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  ARQUIVO MAIN / LOADER — publique na RAIZ do repositório    ║
 * ║  Nome obrigatório no GitHub: LG-Tracking.user.js            ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * O loader é instalado uma vez. Em cada abertura do jogo ele busca o núcleo
 * oficial no GitHub; se a rede falhar, usa a última cópia válida em cache.
 *
 * O código executado no navegador nunca é secreto: qualquer pessoa pode
 * inspecionar o arquivo que o browser recebe. O loader existe para manter a
 * instalação pequena e evitar que jogadores reinstalem o userscript a cada build.
 */

(() => {
  'use strict';

  const PREFIX = '[Mope 1v1\'s Loader]';
  const CORE_URL = 'https://raw.githubusercontent.com/cute-hardware/mope-1v1s/main/core/LG-Tracking.core.js';
  const CACHE_KEY = 'mope-1v1s.core-cache.v1';
  let started = false;

  function warn(message, error) {
    console.warn(PREFIX, message, error ?? '');
  }

  function executeCore(code, origin) {
    if (started || typeof code !== 'string' || !code.includes('Mope 1v1\'s')) return false;
    try {
      // The core is an IIFE and runs in this same Tampermonkey sandbox, retaining
      // the explicitly granted GM APIs above.
      eval(code);
      started = true;
      console.info(PREFIX, `Núcleo iniciado: ${origin}.`);
      return true;
    } catch (error) {
      warn(`Não foi possível iniciar o núcleo de ${origin}.`, error);
      return false;
    }
  }

  function startCachedCore() {
    try {
      const cached = typeof GM_getValue === 'function' ? GM_getValue(CACHE_KEY, '') : '';
      return executeCore(cached, 'cache local');
    } catch (error) {
      warn('Não foi possível ler o cache local.', error);
      return false;
    }
  }

  if (typeof GM_xmlhttpRequest !== 'function') {
    warn('GM_xmlhttpRequest não está disponível; reinstale pelo Tampermonkey.');
    return;
  }

  GM_xmlhttpRequest({
    method: 'GET',
    url: CORE_URL,
    headers: { Accept: 'text/javascript, application/javascript, text/plain;q=0.9, */*;q=0.1' },
    timeout: 15_000,
    onload(response) {
      const code = response.status >= 200 && response.status < 300 ? response.responseText : '';
      if (executeCore(code, 'GitHub')) {
        try {
          GM_setValue(CACHE_KEY, code);
        } catch (error) {
          warn('O núcleo foi iniciado, mas não pôde ser salvo em cache.', error);
        }
        return;
      }
      if (!startCachedCore()) warn(`O GitHub respondeu HTTP ${response.status} e não há um cache válido.`);
    },
    onerror(error) {
      if (!startCachedCore()) warn('Falha de rede e não há um cache válido.', error);
    },
    ontimeout() {
      if (!startCachedCore()) warn('Tempo esgotado ao buscar o núcleo e não há um cache válido.');
    },
  });
})();
