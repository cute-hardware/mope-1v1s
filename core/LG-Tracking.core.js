/*
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  ARQUIVO CORE — publique dentro da pasta core/ no GitHub     ║
 * ║  Caminho obrigatório: core/LG-Tracking.core.js               ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Mope 1v1's — core carregado pelo LG-Tracking Loader.
 * Build do núcleo: 1.0.2
 * Este arquivo não deve ser instalado diretamente no Tampermonkey.
 */

/*
 * Mope 1v1's — sensor de partidas
 *
 * Princípios desta versão:
 * - apenas lê o estado já recebido pelo cliente;
 * - não chama network.send() nem WebSocket.send();
 * - envia o resumo final somente para a API relay oficial fixa; a API é responsável pelo bot Discord;
 * - não cria teclas, cliques, movimento ou qualquer automação;
 * - a única alteração visual é uma etiqueta cosmética ao lado de nomes verificados de clan;
 * - não grava identificadores de conta/sessão.
 *
 * O cliente atual do mope.io é modular. Em vez de depender de uma variável global
 * inexistente, este script localiza, depois do carregamento, a instância já criada
 * do cliente entre os módulos que a própria página pré-carregou. A descoberta é
 * feita por capacidade (network + animalStats + classes + loop), não pelo hash do
 * arquivo de build. Se o cliente mudar, o script falha de forma segura e apenas
 * avisa no console.
 */

(() => {
  'use strict';

  const TRACKER_NAME = "Mope 1v1's";
  const LG_PREFIX = `[${TRACKER_NAME}]`;
  const VERSION = '1.0.2';
  const POLL_INTERVAL_MS = 250;
  const RELAY_ORIGIN = 'https://mope-1v1s.hoyegg0.workers.dev';
  const RELAY_ENDPOINT = `${RELAY_ORIGIN}/v1/matches`;
  const INSTALL_ENDPOINT = `${RELAY_ORIGIN}/v1/install`;
  const LINK_COMPLETE_ENDPOINT = `${RELAY_ORIGIN}/v1/link/complete`;
  const PRESENCE_ENDPOINT = `${RELAY_ORIGIN}/v1/presence`;
  const CLAN_TAGS_ENDPOINT = `${RELAY_ORIGIN}/v1/clan-tags`;
  const LINK_QUERY_PARAMETER = 'm1link';
  const PRESENCE_HEARTBEAT_MS = 25_000;
  const CLAN_TAG_DIRECTORY_REFRESH_MS = 20_000;
  const CLAN_TAG_RENDER_INTERVAL_MS = 700;
  const CLAN_TAG_SETTINGS_STORAGE_KEY = 'mope-1v1s.clanTagStyle.v1';
  const DEFAULT_CLAN_TAG_STYLE = Object.freeze({ color: '#F2C94C', side: 'right' });
  // Keep the tag visibly subordinate to the copied native player name.
  const CLAN_TAG_NAME_SCALE = 0.85;
  // Let the final arena/result animation settle before notifying the relay.
  const RELAY_POST_END_DELAY_MS = 1500;
  // Wait after final evidence before reading the final visual arena frame.
  const SCREENSHOT_FINAL_DELAY_MS = 1000;
  // A final arena frame only: never run a GPU readback for ordinary score changes.
  // Keep the native canvas detail whenever it fits; the hard 1280×720 ceiling remains.
  // This avoids unnecessarily shrinking lower-resolution game windows to 2/3.
  const SCREENSHOT_PREFERRED_RESOLUTION = 1;
  const SCREENSHOT_MAX_OUTPUT_WIDTH = 1280;
  const SCREENSHOT_MAX_OUTPUT_HEIGHT = 720;
  const INSTALLATION_TOKEN_STORAGE_KEY = 'mope-1v1s.installationToken.v1';
  const STATS_STORAGE_KEY = 'mope-1v1s.localStats.v1';
  const MAX_MATCH_HISTORY = 50;

  /*
   * Confirmado na build do cliente inspecionada em 2026-10-03:
   * a mensagem de rede stopGameSession usa o prefixo 5 e traz o resumo de morte.
   * O decodificador abaixo é opcional: ele valida integralmente o buffer antes de
   * usar qualquer campo. Se o protocolo mudar, ele simplesmente ignora o pacote.
   */
  const CURRENT_STOP_GAME_SESSION_PREFIX = 5;

  const state = {
    client: null,
    clientModuleUrl: null,
    timer: null,
    player: null,
    lastKnownPlayerName: null,
    serverKey: null,
    transport: { socket: null, readyState: null },
    arena: null,
    lastStopSession: null,
    installationToken: null,
    installationPromise: null,
    presenceLastAttemptAt: 0,
    presenceLastFingerprint: null,
    presenceInFlight: false,
    presenceLinkMissing: false,
    clanTagStyle: { ...DEFAULT_CLAN_TAG_STYLE },
    clanTagDirectory: new Map(),
    localClanTag: null,
    clanTagDirectoryLastAttemptAt: 0,
    clanTagDirectoryInFlight: false,
    clanTagDirectoryLinkMissing: false,
    clanTagLastRenderAt: 0,
    clanTagVisuals: new Map(),
    clanTagOwners: new WeakMap(),
    clanTagOwnerHooks: new WeakMap(),
    clanTagSettingsPanel: null,
    startedAt: Date.now(),
  };

  const listeners = new Set();

  // Current client build: the usual 1v1 apex species. This fills the name when the
  // opponent has a skin, whose texture path does not expose the animal slug.
  const speciesById = new Map([
    [89, 'dragon'],
    [90, 'phoenix'],
    [91, 'trex'],
    [92, 'king_crab'],
    [93, 'kraken'],
    [94, 'yeti'],
    [95, 'pterodactyl'],
    [101, 'black_dragon'],
    [102, 'king_dragon'],
  ]);

  function now() {
    return new Date().toISOString();
  }

  function plain(value) {
    // Console output should be serializable and should never expose a live game object.
    if (value === undefined) return undefined;
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(plain);
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== 'function' && item !== undefined) result[key] = plain(item);
    }
    return result;
  }

  function emit(type, payload = {}) {
    const event = Object.freeze({
      source: `${TRACKER_NAME} Sensor`,
      version: VERSION,
      type,
      at: now(),
      ...plain(payload),
    });

    // The first line is deliberately easy to filter in DevTools.
    console.log(`${LG_PREFIX} Event: ${type}`, event);

    for (const callback of listeners) {
      try {
        callback(event);
      } catch (error) {
        console.warn(`${LG_PREFIX} Listener local falhou`, error);
      }
    }

    // Local browser event only. It is a future integration point; nothing leaves the page.
    window.dispatchEvent(new CustomEvent('lg-tracking:event', { detail: event }));
    return event;
  }

  function warn(message, extra) {
    console.warn(`${LG_PREFIX} ${message}`, extra ?? '');
  }

  function readStoredValue(key, fallback) {
    try {
      return typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback;
    } catch (error) {
      warn('Não foi possível ler a configuração local do Tampermonkey.', error);
      return fallback;
    }
  }

  function writeStoredValue(key, value) {
    try {
      if (typeof GM_setValue !== 'function') throw new Error('GM_setValue indisponível');
      GM_setValue(key, value);
      return true;
    } catch (error) {
      warn('Não foi possível salvar a configuração local do Tampermonkey.', error);
      return false;
    }
  }

  function validClanTagColor(value) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : null;
  }

  function validClanTagSide(value) {
    // The legacy key is retained for storage/API compatibility; it now describes
    // any of the four positions around the name label.
    return value === 'left' || value === 'right' || value === 'top' || value === 'bottom' ? value : null;
  }

  function validClanDisplayTag(value) {
    if (typeof value !== 'string') return null;
    // Keep stylised Unicode glyphs (e.g. ⦕𝒳𝒳⦖) exactly as configured by the leader.
    const tag = value.normalize('NFC').trim();
    const length = [...tag].length;
    return length >= 2 && length <= 16 && !/[\p{C}\s\\`*_~|\[\]]/u.test(tag) && /[\p{L}\p{N}]/u.test(tag) ? tag : null;
  }

  function hexToHsv(hex) {
    const color = validClanTagColor(hex) ?? DEFAULT_CLAN_TAG_STYLE.color;
    const red = parseInt(color.slice(1, 3), 16) / 255;
    const green = parseInt(color.slice(3, 5), 16) / 255;
    const blue = parseInt(color.slice(5, 7), 16) / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    let hue = 0;
    if (delta) {
      if (max === red) hue = 60 * (((green - blue) / delta) % 6);
      else if (max === green) hue = 60 * ((blue - red) / delta + 2);
      else hue = 60 * ((red - green) / delta + 4);
    }
    if (hue < 0) hue += 360;
    return { h: hue, s: max ? delta / max : 0, v: max };
  }

  function hsvToHex(hue, saturation, value) {
    const h = ((Number(hue) % 360) + 360) % 360;
    const s = Math.max(0, Math.min(1, Number(saturation) || 0));
    const v = Math.max(0, Math.min(1, Number(value) || 0));
    const chroma = v * s;
    const match = chroma * (1 - Math.abs((h / 60) % 2 - 1));
    const base = v - chroma;
    let red = 0;
    let green = 0;
    let blue = 0;
    if (h < 60) [red, green, blue] = [chroma, match, 0];
    else if (h < 120) [red, green, blue] = [match, chroma, 0];
    else if (h < 180) [red, green, blue] = [0, chroma, match];
    else if (h < 240) [red, green, blue] = [0, match, chroma];
    else if (h < 300) [red, green, blue] = [match, 0, chroma];
    else [red, green, blue] = [chroma, 0, match];
    const channel = (number) => Math.round((number + base) * 255).toString(16).padStart(2, '0');
    return `#${channel(red)}${channel(green)}${channel(blue)}`.toUpperCase();
  }

  function parseClanHex(value) {
    const raw = typeof value === 'string' ? value.trim().replace(/^#/, '') : '';
    if (!/^[0-9a-f]{6}$/i.test(raw)) return null;
    return `#${raw.toUpperCase()}`;
  }

  function syncClanColorPicker(panel) {
    const area = panel.querySelector('[data-lg-tag-sv-area]');
    const marker = panel.querySelector('[data-lg-tag-sv-marker]');
    const hueInput = panel.querySelector('[data-lg-tag-hue]');
    if (!area || !marker || !hueInput) return;
    const hsv = hexToHsv(state.clanTagStyle.color);
    area.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h}, 100%, 50%))`;
    marker.style.left = `${Math.round(hsv.s * 100)}%`;
    marker.style.top = `${Math.round((1 - hsv.v) * 100)}%`;
    hueInput.value = String(Math.round(hsv.h));
    const current = panel.querySelector('[data-lg-tag-picker-current]');
    if (current) current.style.background = state.clanTagStyle.color;
    const hexInput = panel.querySelector('[data-lg-tag-hex]');
    if (hexInput && document.activeElement !== hexInput) hexInput.value = state.clanTagStyle.color.slice(1);
  }

  function updateClanPickerSaturationValue(event) {
    const area = event.currentTarget;
    const bounds = area.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const saturation = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const value = 1 - Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    const { h } = hexToHsv(state.clanTagStyle.color);
    saveClanTagStyle({ ...state.clanTagStyle, color: hsvToHex(h, saturation, value) });
  }

  function loadClanTagStyle() {
    const stored = readStoredValue(CLAN_TAG_SETTINGS_STORAGE_KEY, DEFAULT_CLAN_TAG_STYLE);
    const candidate = stored && typeof stored === 'object' ? stored : {};
    state.clanTagStyle = {
      color: validClanTagColor(candidate.color) ?? DEFAULT_CLAN_TAG_STYLE.color,
      side: validClanTagSide(candidate.side) ?? DEFAULT_CLAN_TAG_STYLE.side,
    };
  }

  function saveClanTagStyle(nextStyle) {
    state.clanTagStyle = {
      color: validClanTagColor(nextStyle?.color) ?? DEFAULT_CLAN_TAG_STYLE.color,
      side: validClanTagSide(nextStyle?.side) ?? DEFAULT_CLAN_TAG_STYLE.side,
    };
    writeStoredValue(CLAN_TAG_SETTINGS_STORAGE_KEY, state.clanTagStyle);
    // Send the preference with the next ordinary presence heartbeat; it is only
    // used to render this member's verified clan tag for other opted-in scripts.
    state.presenceLastAttemptAt = 0;
    state.clanTagDirectoryLastAttemptAt = 0;
    refreshClanTagSettingsPanel();
  }

  function displayClanTagText(tag) {
    const safeTag = validClanDisplayTag(tag);
    if (!safeTag) return '[TAG]';
    // Legacy/technical tags keep the familiar brackets; decorated tags such as
    // ⦕𝒳𝒳⦖ are intentionally rendered exactly as the clan leader configured them.
    return /^[A-Z0-9]{2,8}$/.test(safeTag) ? `[${safeTag}]` : safeTag;
  }

  function currentClanTagPreview() {
    const localName = state.player?.name ?? state.lastKnownPlayerName;
    const entry = clanTagForName(localName);
    return displayClanTagText(state.localClanTag ?? entry?.tag);
  }

  function attachClanTagSettingsToMenu() {
    const panel = state.clanTagSettingsPanel;
    const nameInput = document.getElementById('name');
    const nameRow = nameInput?.closest('.nameRow');
    if (!panel || !nameInput || !nameRow) return false;
    // Be a real child of the Mope menu row rather than a floating screen overlay.
    // Svelte can rebuild this menu, so this is safely rechecked on every sensor tick.
    if (panel.parentElement !== nameRow) nameRow.append(panel);
    nameRow.classList.add('lg-clan-tag-name-row');
    const nameHeight = Math.round(nameInput.getBoundingClientRect().height);
    if (nameHeight > 0) nameRow.style.setProperty('--lg-clan-name-height', `${nameHeight}px`);
    return true;
  }

  function refreshClanTagSettingsPanel() {
    const panel = state.clanTagSettingsPanel;
    if (!panel) return;
    const attached = attachClanTagSettingsToMenu();
    panel.hidden = Boolean(state.player) || !attached;
    if (panel.hidden) return;
    panel.classList.toggle('lg-tag-side-right', state.clanTagStyle.side === 'right');
    panel.classList.toggle('lg-tag-side-left', state.clanTagStyle.side === 'left');
    panel.classList.toggle('lg-tag-side-top', state.clanTagStyle.side === 'top');
    panel.classList.toggle('lg-tag-side-bottom', state.clanTagStyle.side === 'bottom');
    const nameRow = panel.parentElement?.classList?.contains('nameRow') ? panel.parentElement : null;
    nameRow?.classList.toggle('lg-clan-tag-layout-top', state.clanTagStyle.side === 'top');
    nameRow?.classList.toggle('lg-clan-tag-layout-bottom', state.clanTagStyle.side === 'bottom');
    const control = panel.querySelector('.lg-tag-control');
    if (control) control.style.setProperty('--lg-tag-color', state.clanTagStyle.color);
    const swatch = panel.querySelector('[data-lg-tag-swatch]');
    if (swatch) swatch.title = `Cor da tag: ${state.clanTagStyle.color}`;
    const preview = panel.querySelector('[data-lg-tag-preview]');
    if (preview) {
      preview.textContent = currentClanTagPreview();
      preview.style.color = state.clanTagStyle.color;
    }
    for (const button of panel.querySelectorAll('[data-lg-tag-position]')) {
      const selected = button.dataset.lgTagPosition === state.clanTagStyle.side;
      button.classList.toggle('lg-tag-position-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    const positionPanel = panel.querySelector('[data-lg-tag-position-panel]');
    if (preview && positionPanel) preview.setAttribute('aria-expanded', String(!positionPanel.hidden));
    syncClanColorPicker(panel);
  }

  function updateClanTagSettingsVisibility() {
    const panel = state.clanTagSettingsPanel;
    if (!panel) return;
    refreshClanTagSettingsPanel();
  }

  function installClanTagSettingsPanel() {
    if (state.clanTagSettingsPanel || !document.body) return;
    const panel = document.createElement('section');
    panel.id = 'lg-clan-tag-settings';
    panel.setAttribute('aria-label', 'Personalização da tag de clan');
    panel.innerHTML = `
      <style>
        /* Direct children of .nameRow: this deliberately uses the real Mope menu layout. */
        #lg-clan-tag-settings { display:contents; font-family:Arial,Helvetica,sans-serif; user-select:none; }
        #lg-clan-tag-settings[hidden] { display:none; }
        .nameRow.lg-clan-tag-name-row { position:relative !important; overflow:visible !important; display:flex !important; align-items:center !important; gap:7px !important; }
        .nameRow.lg-clan-tag-name-row #name { order:1; flex:1 1 0 !important; min-width:0 !important; width:auto !important; }
        /* One full-colour square, matched to the real #name input height. */
        #lg-clan-tag-settings .lg-tag-control { order:0; flex:0 0 var(--lg-clan-name-height,42px); width:var(--lg-clan-name-height,42px); height:var(--lg-clan-name-height,42px); }
        #lg-clan-tag-settings .lg-tag-swatch { box-sizing:border-box; width:100%; height:100%; padding:0; cursor:pointer; border:.5dvmin solid #1f9a1f; border-radius:var(--radius-sm); background:var(--lg-tag-color,#f2c94c); box-shadow:none; transition:transform .1s ease,filter .1s ease; }
        #lg-clan-tag-settings .lg-tag-swatch:hover { transform:translateY(-1px); filter:brightness(1.07) saturate(1.05); }
        /* The visible tag is the position selector trigger.  It deliberately stays
           transparent; only the four-direction popover gets the native green frame. */
        #lg-clan-tag-settings .lg-tag-preview { order:2; flex:0 0 auto; max-width:84px; padding:0; overflow:hidden; white-space:nowrap; cursor:pointer; background:transparent; border:0; box-shadow:none; color:inherit; font:800 17px/31px Arial,Helvetica,sans-serif; text-align:center; text-shadow:0 1px 1px rgba(0,0,0,.7), 0 0 2px rgba(0,0,0,.75); }
        #lg-clan-tag-settings .lg-tag-preview:hover { filter:brightness(1.15); transform:translateY(-1px); }
        #lg-clan-tag-settings .lg-tag-preview:focus-visible { outline:.35dvmin solid #1f9a1f; outline-offset:2px; border-radius:var(--radius-sm); }
        #lg-clan-tag-settings.lg-tag-side-left .lg-tag-preview { order:0; }
        #lg-clan-tag-settings.lg-tag-side-left .lg-tag-control { order:2; }
        /* The start-screen preview follows ↑/↓ too, rather than only changing in game. */
        .nameRow.lg-clan-tag-layout-top, .nameRow.lg-clan-tag-layout-bottom { display:grid !important; grid-template-columns:var(--lg-clan-name-height,42px) minmax(0,1fr); column-gap:7px; row-gap:2px; align-items:center !important; }
        .nameRow.lg-clan-tag-layout-top { grid-template-rows:auto var(--lg-clan-name-height,42px); }
        .nameRow.lg-clan-tag-layout-bottom { grid-template-rows:var(--lg-clan-name-height,42px) auto; }
        .nameRow.lg-clan-tag-layout-top #name, .nameRow.lg-clan-tag-layout-bottom #name { grid-column:2; }
        .nameRow.lg-clan-tag-layout-top #name { grid-row:2; }
        .nameRow.lg-clan-tag-layout-bottom #name { grid-row:1; }
        .nameRow.lg-clan-tag-layout-top #lg-clan-tag-settings .lg-tag-control, .nameRow.lg-clan-tag-layout-bottom #lg-clan-tag-settings .lg-tag-control { grid-column:1; }
        .nameRow.lg-clan-tag-layout-top #lg-clan-tag-settings .lg-tag-control { grid-row:2; }
        .nameRow.lg-clan-tag-layout-bottom #lg-clan-tag-settings .lg-tag-control { grid-row:1; }
        .nameRow.lg-clan-tag-layout-top #lg-clan-tag-settings .lg-tag-preview, .nameRow.lg-clan-tag-layout-bottom #lg-clan-tag-settings .lg-tag-preview { grid-column:1 / 3; justify-self:center; max-width:100%; }
        .nameRow.lg-clan-tag-layout-top #lg-clan-tag-settings .lg-tag-preview { grid-row:1; }
        .nameRow.lg-clan-tag-layout-bottom #lg-clan-tag-settings .lg-tag-preview { grid-row:2; }
        /* Compact native-name controls, opening to the right — never over Jogar. */
        #lg-clan-tag-settings .lg-tag-position-panel { position:absolute; z-index:2147483647; top:0; left:calc(100% + .6dvmin); right:auto; display:grid; grid-template-columns:repeat(3,3dvmin); grid-template-rows:repeat(3,3dvmin); gap:.35dvmin; padding:0; box-sizing:border-box; border:0; border-radius:0; background:transparent; box-shadow:none; }
        #lg-clan-tag-settings .lg-tag-position-panel[hidden] { display:none; }
        #lg-clan-tag-settings .lg-tag-position { box-sizing:border-box; width:3dvmin; height:3dvmin; padding:0; cursor:pointer; border:.5dvmin solid #1f9a1f; border-radius:.35dvmin; outline:0; background:#fff; color:#000; display:grid; place-items:center; text-align:center; transition:background-color .12s ease,transform .12s ease; }
        #lg-clan-tag-settings .lg-tag-position-arrow { display:block; font:1.8dvmin/1 Arial,Helvetica,sans-serif; transform:rotate(var(--lg-tag-arrow-turn,0deg)); }
        #lg-clan-tag-settings .lg-tag-position[data-lg-tag-position="top"] .lg-tag-position-arrow { --lg-tag-arrow-turn:-90deg; }
        #lg-clan-tag-settings .lg-tag-position[data-lg-tag-position="left"] .lg-tag-position-arrow { --lg-tag-arrow-turn:180deg; }
        #lg-clan-tag-settings .lg-tag-position[data-lg-tag-position="bottom"] .lg-tag-position-arrow { --lg-tag-arrow-turn:90deg; }
        #lg-clan-tag-settings .lg-tag-position:hover, #lg-clan-tag-settings .lg-tag-position:focus-visible { background:#eef9ee; }
        #lg-clan-tag-settings .lg-tag-position:active { transform:translateY(1px); }
        #lg-clan-tag-settings .lg-tag-position.lg-tag-position-selected { background:#dff4df; box-shadow:inset 0 0 0 .1dvmin #1f9a1f; }
        #lg-clan-tag-settings .lg-tag-position[data-lg-tag-position="top"] { grid-column:2; grid-row:1; }
        #lg-clan-tag-settings .lg-tag-position[data-lg-tag-position="left"] { grid-column:1; grid-row:2; }
        #lg-clan-tag-settings .lg-tag-position[data-lg-tag-position="right"] { grid-column:3; grid-row:2; }
        #lg-clan-tag-settings .lg-tag-position[data-lg-tag-position="bottom"] { grid-column:2; grid-row:3; }
        /* Same visual hierarchy as the provided picker panel, with no React/Tailwind runtime required. */
        #lg-clan-tag-settings .lg-tag-color-panel { position:absolute; z-index:2147483647; top:calc(100% + 10px); width:268px; overflow:hidden; box-sizing:border-box; border:1px solid rgba(0,0,0,.14); border-radius:16px; background:#fff; color:#18181b; box-shadow:0 1px 2px rgba(0,0,0,.1),0 18px 48px -24px rgba(0,0,0,.42); }
        #lg-clan-tag-settings .lg-tag-color-panel[hidden] { display:none; }
        #lg-clan-tag-settings.lg-tag-side-right .lg-tag-color-panel, #lg-clan-tag-settings.lg-tag-side-top .lg-tag-color-panel, #lg-clan-tag-settings.lg-tag-side-bottom .lg-tag-color-panel { left:0; }
        #lg-clan-tag-settings.lg-tag-side-left .lg-tag-color-panel { right:0; }
        #lg-clan-tag-settings .lg-tag-sv-area { position:relative; width:100%; height:164px; overflow:hidden; cursor:crosshair; border:0; border-radius:15px 15px 0 0; box-sizing:border-box; touch-action:none; }
        #lg-clan-tag-settings .lg-tag-sv-marker { position:absolute; width:16px; height:16px; box-sizing:border-box; border:2px solid #fff; border-radius:50%; box-shadow:0 0 0 1px rgba(0,0,0,.38),0 1px 4px rgba(0,0,0,.4); transform:translate(-50%,-50%); pointer-events:none; }
        #lg-clan-tag-settings .lg-tag-picker-body { padding:12px; display:flex; flex-direction:column; gap:12px; }
        #lg-clan-tag-settings .lg-tag-hue { width:100%; height:12px; margin:0; appearance:none; -webkit-appearance:none; border:0; border-radius:999px; background:linear-gradient(to right,#f00 0%,#ff0 17%,#0f0 33%,#0ff 50%,#00f 67%,#f0f 83%,#f00 100%); cursor:pointer; box-shadow:inset 0 0 0 1px rgba(0,0,0,.12); }
        #lg-clan-tag-settings .lg-tag-hue::-webkit-slider-thumb { appearance:none; -webkit-appearance:none; width:18px; height:18px; border:2px solid #fff; border-radius:50%; background:#fff; box-shadow:0 0 0 1px rgba(0,0,0,.34),0 1px 4px rgba(0,0,0,.4); }
        #lg-clan-tag-settings .lg-tag-hue::-moz-range-thumb { width:18px; height:18px; border:2px solid #fff; border-radius:50%; background:#fff; box-shadow:0 0 0 1px rgba(0,0,0,.34),0 1px 4px rgba(0,0,0,.4); }
        #lg-clan-tag-settings .lg-tag-picker-footer { display:flex; align-items:center; gap:10px; }
        #lg-clan-tag-settings .lg-tag-picker-current { width:32px; height:32px; flex:0 0 32px; border:1px solid rgba(0,0,0,.14); border-radius:7px; background:var(--lg-tag-color,#f2c94c); box-shadow:inset 0 0 0 1px rgba(255,255,255,.2); }
        #lg-clan-tag-settings .lg-tag-hex-shell { height:32px; flex:1; display:flex; align-items:center; overflow:hidden; border:1px solid #d4d4d8; border-radius:10px; background:#fff; color:#71717a; font:600 12px Arial,sans-serif; transition:border-color .15s ease,box-shadow .15s ease; }
        #lg-clan-tag-settings .lg-tag-hex-shell:focus-within { border-color:rgba(0,0,0,.3); box-shadow:0 0 0 2px rgba(0,0,0,.1); }
        #lg-clan-tag-settings .lg-tag-hex-prefix { padding-left:10px; }
        #lg-clan-tag-settings .lg-tag-hex { width:100%; min-width:0; border:0; outline:0; background:transparent; color:#18181b; padding:0 10px 0 3px; font:600 12px Arial,sans-serif; letter-spacing:.08em; text-transform:uppercase; } 
      </style>
      <div class="lg-tag-control">
        <button type="button" class="lg-tag-swatch" data-lg-tag-swatch aria-label="Abrir seletor de cor da tag"></button>
      </div>
      <button type="button" class="lg-tag-preview" data-lg-tag-preview aria-label="Escolher posição da tag" aria-haspopup="dialog" aria-expanded="false"></button>
      <div class="lg-tag-position-panel" data-lg-tag-position-panel role="dialog" aria-label="Posição da tag" hidden>
        <button type="button" class="lg-tag-position" data-lg-tag-position="top" aria-label="Tag acima"><span class="lg-tag-position-arrow">➜</span></button>
        <button type="button" class="lg-tag-position" data-lg-tag-position="left" aria-label="Tag à esquerda"><span class="lg-tag-position-arrow">➜</span></button>
        <button type="button" class="lg-tag-position" data-lg-tag-position="right" aria-label="Tag à direita"><span class="lg-tag-position-arrow">➜</span></button>
        <button type="button" class="lg-tag-position" data-lg-tag-position="bottom" aria-label="Tag abaixo"><span class="lg-tag-position-arrow">➜</span></button>
      </div>
      <div class="lg-tag-color-panel" data-lg-tag-color-panel hidden>
        <div class="lg-tag-sv-area" data-lg-tag-sv-area><span class="lg-tag-sv-marker" data-lg-tag-sv-marker></span></div>
        <div class="lg-tag-picker-body">
          <input type="range" class="lg-tag-hue" data-lg-tag-hue min="0" max="360" step="1" aria-label="Tom da cor">
          <div class="lg-tag-picker-footer">
            <span class="lg-tag-picker-current" data-lg-tag-picker-current></span>
            <label class="lg-tag-hex-shell"><span class="lg-tag-hex-prefix">#</span><input type="text" class="lg-tag-hex" data-lg-tag-hex maxlength="6" spellcheck="false" autocomplete="off" aria-label="Cor hexadecimal"></label>
          </div>
        </div>
      </div>
    `;
    document.body.append(panel);
    state.clanTagSettingsPanel = panel;
    const colorPanel = panel.querySelector('[data-lg-tag-color-panel]');
    const positionPanel = panel.querySelector('[data-lg-tag-position-panel]');
    const preview = panel.querySelector('[data-lg-tag-preview]');
    panel.querySelector('[data-lg-tag-swatch]')?.addEventListener('click', () => {
      positionPanel?.setAttribute('hidden', '');
      colorPanel?.toggleAttribute('hidden');
      syncClanColorPicker(panel);
    });
    preview?.addEventListener('click', () => {
      colorPanel?.setAttribute('hidden', '');
      positionPanel?.toggleAttribute('hidden');
      refreshClanTagSettingsPanel();
    });
    for (const button of panel.querySelectorAll('[data-lg-tag-position]')) {
      button.addEventListener('click', () => {
        const side = validClanTagSide(button.dataset.lgTagPosition);
        if (!side) return;
        positionPanel?.setAttribute('hidden', '');
        saveClanTagStyle({ ...state.clanTagStyle, side });
      });
    }
    const svArea = panel.querySelector('[data-lg-tag-sv-area]');
    svArea?.addEventListener('pointerdown', (event) => {
      svArea.setPointerCapture?.(event.pointerId);
      updateClanPickerSaturationValue(event);
    });
    svArea?.addEventListener('pointermove', (event) => {
      if (event.buttons === 1) updateClanPickerSaturationValue(event);
    });
    panel.querySelector('[data-lg-tag-hue]')?.addEventListener('input', (event) => {
      const { s, v } = hexToHsv(state.clanTagStyle.color);
      saveClanTagStyle({ ...state.clanTagStyle, color: hsvToHex(event.currentTarget.value, s, v) });
    });
    const hexInput = panel.querySelector('[data-lg-tag-hex]');
    const commitHex = () => {
      const color = parseClanHex(hexInput?.value);
      if (color) saveClanTagStyle({ ...state.clanTagStyle, color });
      else if (hexInput) hexInput.value = state.clanTagStyle.color.slice(1);
    };
    hexInput?.addEventListener('blur', commitHex);
    hexInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitHex();
        hexInput.blur();
      }
    });
    refreshClanTagSettingsPanel();
  }

  function restoreNativeNamePosition(record) {
    const source = record?.source;
    const native = record?.nativeNamePosition;
    if (source && native && Number.isFinite(native.x) && Number.isFinite(native.y)) {
      source.position?.set?.(native.x, native.y);
      if (!source.position?.set) {
        source.x = native.x;
        source.y = native.y;
      }
    }
    const wins = record?.owner?.arenaWins;
    const nativeWins = record?.nativeWinsPosition;
    if (wins && nativeWins && Number.isFinite(nativeWins.x) && Number.isFinite(nativeWins.y)) {
      wins.position?.set?.(nativeWins.x, nativeWins.y);
      if (!wins.position?.set) {
        wins.x = nativeWins.x;
        wins.y = nativeWins.y;
      }
    }
    if (record) {
      record.topStackApplied = false;
      record.nativeNamePosition = null;
      record.nativeWinsPosition = null;
    }
  }

  function removeClanTagVisual(record) {
    restoreNativeNamePosition(record);
    uninstallClanNameStackHook(record?.owner);
    try {
      record.label?.parent?.removeChild?.(record.label);
      record.label?.destroy?.();
    } catch {
      // A destroyed Pixi display object is harmless and should not affect the game.
    }
  }

  function clearClanTagVisuals() {
    for (const record of state.clanTagVisuals.values()) removeClanTagVisual(record);
    state.clanTagVisuals.clear();
  }

  function clanTagTint(hex) {
    const color = validClanTagColor(hex) ?? DEFAULT_CLAN_TAG_STYLE.color;
    return Number.parseInt(color.slice(1), 16);
  }

  function cloneNativeNameStyle(source) {
    const nativeStyle = source?.style;
    if (!nativeStyle || typeof nativeStyle !== 'object') return null;
    try {
      if (typeof nativeStyle.clone === 'function') return nativeStyle.clone();
    } catch {
      // Fall through to a plain options copy for older Pixi style objects.
    }
    const style = {};
    for (const key of [
      'align', 'breakWords', 'dropShadow', 'dropShadowAlpha', 'dropShadowAngle',
      'dropShadowBlur', 'dropShadowColor', 'dropShadowDistance', 'fill', 'fontFamily',
      'fontSize', 'fontStyle', 'fontVariant', 'fontWeight', 'letterSpacing',
      'lineHeight', 'lineJoin', 'miterLimit', 'padding', 'stroke', 'strokeThickness',
      'trim', 'whiteSpace', 'wordWrap', 'wordWrapWidth',
    ]) {
      if (nativeStyle[key] !== undefined) style[key] = nativeStyle[key];
    }
    return Object.keys(style).length ? style : null;
  }

  function applyClanTagLabelColor(label, color) {
    const tint = clanTagTint(color);
    // Keep the native name's copied typography and outline. A white base fill
    // plus Pixi tint produces the selected hex colour exactly for Text and
    // BitmapText-like labels alike, rather than leaving a white fallback.
    try {
      if (label.style) {
        label.style.fill = '#FFFFFF';
        label.style.update?.();
      }
      label.tint = tint;
    } catch {
      // A renderer may expose only one of style/tint; the other assignment is optional.
    }
  }

  function candidateUsesNativeStyle(candidate, nativeStyle) {
    if (!candidate?.style || !nativeStyle) return Boolean(candidate);
    const sourceFont = nativeStyle.fontFamily;
    const candidateFont = candidate.style.fontFamily;
    const sourceSize = Number.parseFloat(nativeStyle.fontSize);
    const candidateSize = Number.parseFloat(candidate.style.fontSize);
    return (sourceFont === undefined || String(sourceFont) === String(candidateFont)) &&
      (!Number.isFinite(sourceSize) || sourceSize === candidateSize);
  }

  function createClanTagLabel(source, entry) {
    const text = displayClanTagText(entry.tag);
    const textStyle = cloneNativeNameStyle(source);
    if (!textStyle) return null;
    let label = null;
    // Try both supported Pixi constructors, but accept only the one that copied
    // the real source-name typography. This makes the tag a true name-label copy.
    for (const construct of [
      () => new source.constructor(text, textStyle),
      () => new source.constructor({ text, style: textStyle }),
    ]) {
      try {
        const candidate = construct();
        if (candidate && typeof candidate === 'object' && 'text' in candidate && candidateUsesNativeStyle(candidate, source.style)) {
          label = candidate;
          break;
        }
        candidate?.destroy?.();
      } catch {
        // Try the alternate Pixi constructor signature.
      }
    }
    if (!label) return null;
    try {
      label.text = text;
      // Copy the same origin as the native name, not a separately centered label.
      const anchorX = Number(source.anchor?.x);
      const anchorY = Number(source.anchor?.y);
      label.anchor?.set?.(Number.isFinite(anchorX) ? anchorX : 0, Number.isFinite(anchorY) ? anchorY : 0);
      const scaleX = Number(source.scale?.x);
      const scaleY = Number(source.scale?.y);
      if (Number.isFinite(scaleX) && Number.isFinite(scaleY)) label.scale?.set?.(scaleX, scaleY);
      applyClanTagLabelColor(label, entry.color);
      label.eventMode = 'none';
      label.interactive = false;
      label.__lgClanTagVisual = true;
      return label;
    } catch {
      try {
        label.destroy?.();
      } catch {
        // Ignore a failed cleanup from an incompatible renderer object.
      }
      return null;
    }
  }

  function setDisplayPosition(display, x, y) {
    display?.position?.set?.(x, y);
    if (!display?.position?.set) {
      display.x = x;
      display.y = y;
    }
  }

  function syncClanTagLabelTransform(source, label) {
    const scaleX = Number(source?.scale?.x);
    const scaleY = Number(source?.scale?.y);
    if (Number.isFinite(scaleX) && Number.isFinite(scaleY)) label?.scale?.set?.(scaleX * CLAN_TAG_NAME_SCALE, scaleY * CLAN_TAG_NAME_SCALE);
    const rotation = Number(source?.rotation);
    if (Number.isFinite(rotation)) label.rotation = rotation;
  }

  function applyTopClanTagTextStack(record) {
    const source = record?.source;
    const label = record?.label;
    if (!source?.parent || !label?.parent) return false;
    const nativeX = Number(source.x);
    const nativeY = Number(source.y);
    const labelHeight = Number(label.height) || 0;
    const nameHeight = Number(source.height) || 0;
    if (!Number.isFinite(nativeX) || !Number.isFinite(nativeY) || labelHeight <= 0 || nameHeight <= 0) return false;

    // This runs immediately after Mope's own renderName(). The tag takes the
    // native name line, then the native name (and wins) move outward together.
    record.nativeNamePosition = { x: nativeX, y: nativeY };
    label.x = nativeX;
    label.y = nativeY;
    const length = Math.hypot(nativeX, nativeY);
    const directionX = length > 0.001 ? nativeX / length : 0;
    const directionY = length > 0.001 ? nativeY / length : 1;
    const spacing = labelHeight + 1;
    setDisplayPosition(source, nativeX + directionX * spacing, nativeY + directionY * spacing);

    const wins = record.owner?.arenaWins;
    if (wins && Number.isFinite(Number(wins.x)) && Number.isFinite(Number(wins.y))) {
      record.nativeWinsPosition = { x: Number(wins.x), y: Number(wins.y) };
      setDisplayPosition(wins, Number(wins.x) + directionX * spacing, Number(wins.y) + directionY * spacing);
    }
    record.topStackApplied = true;
    return true;
  }

  function installClanNameStackHook(record) {
    const owner = record?.owner;
    if (!owner || typeof owner.renderName !== 'function') return false;
    if (state.clanTagOwnerHooks.has(owner)) return true;
    const original = owner.renderName;
    const wrapped = function wrappedClanNameRender(...args) {
      const result = original.apply(this, args);
      const current = state.clanTagVisuals.get(this.name);
      if (current?.side === 'top') {
        syncClanTagLabelTransform(this.name, current.label);
        current.label.alpha = Number.isFinite(this.name.alpha) ? this.name.alpha : 1;
        current.label.visible = this.name.visible !== false;
        applyTopClanTagTextStack(current);
      }
      return result;
    };
    try {
      owner.renderName = wrapped;
      state.clanTagOwnerHooks.set(owner, { original, wrapped });
      return true;
    } catch {
      return false;
    }
  }

  function uninstallClanNameStackHook(owner) {
    const hook = owner && state.clanTagOwnerHooks.get(owner);
    if (!hook) return;
    try {
      if (owner.renderName === hook.wrapped) owner.renderName = hook.original;
    } catch {
      // The entity may already be destroyed; WeakMap cleanup is still safe.
    }
    state.clanTagOwnerHooks.delete(owner);
  }

  function placeClanTagLabel(source, record, entry) {
    const parent = source?.parent;
    if (!parent || typeof parent.addChild !== 'function') return false;
    if (record.label.parent !== parent) {
      try {
        parent.addChild(record.label);
      } catch {
        return false;
      }
    }
    const sourceX = Number(source.x);
    const sourceY = Number(source.y);
    if (!Number.isFinite(sourceX) || !Number.isFinite(sourceY)) return false;
    syncClanTagLabelTransform(source, record.label);
    applyClanTagLabelColor(record.label, entry.color);
    const sourceWidth = Number(source.width) || 0;
    const sourceHeight = Number(source.height) || 0;
    const sourceAnchorX = Number(source.anchor?.x);
    const sourceAnchorY = Number(source.anchor?.y);
    const labelAnchorX = Number(record.label.anchor?.x);
    const labelAnchorY = Number(record.label.anchor?.y);
    const anchorX = Number.isFinite(sourceAnchorX) ? sourceAnchorX : 0;
    const anchorY = Number.isFinite(sourceAnchorY) ? sourceAnchorY : 0;
    const tagAnchorX = Number.isFinite(labelAnchorX) ? labelAnchorX : 0;
    const tagAnchorY = Number.isFinite(labelAnchorY) ? labelAnchorY : 0;
    const sourceLeft = sourceX - sourceWidth * anchorX;
    const sourceRight = sourceLeft + sourceWidth;
    const sourceTop = sourceY - sourceHeight * anchorY;
    const sourceBottom = sourceTop + sourceHeight;
    const labelWidth = Number(record.label.width) || 0;
    const labelHeight = Number(record.label.height) || 0;
    const gap = Math.max(2, Math.min(6, sourceHeight * 0.18));

    if (entry.side === 'top') {
      if (installClanNameStackHook(record) && !record.topStackApplied) applyTopClanTagTextStack(record);
    } else {
      if (record.topStackApplied) restoreNativeNamePosition(record);
      uninstallClanNameStackHook(record.owner);
      if (entry.side === 'left') {
        record.label.x = sourceLeft - gap - labelWidth * (1 - tagAnchorX);
        record.label.y = sourceY;
      } else if (entry.side === 'bottom') {
        record.label.x = sourceX;
        record.label.y = sourceBottom + gap + labelHeight * tagAnchorY;
      } else {
        record.label.x = sourceRight + gap + labelWidth * tagAnchorX;
        record.label.y = sourceY;
      }
    }
    record.label.alpha = Number.isFinite(source.alpha) ? source.alpha : 1;
    record.label.visible = source.visible !== false;
    if (Number.isFinite(source.zIndex)) record.label.zIndex = source.zIndex + 1;
    return true;
  }

  function sourceEntriesForClanTags(client) {
    const sources = new Set();
    const addSource = (source, owner = null) => {
      if (source && !source.__lgClanTagVisual && typeof source.text === 'string' && source.parent) {
        sources.add(source);
        if (owner) state.clanTagOwners.set(source, owner);
      }
    };
    const stage = client?.loop?.stage;
    if (stage) {
      const stack = [stage];
      let visited = 0;
      while (stack.length && visited < 3500) {
        const node = stack.pop();
        if (!node || visited++ > 3500) continue;
        addSource(node);
        if (Array.isArray(node.children)) {
          for (const child of node.children) stack.push(child);
        }
      }
    }

    // The local player's label is reliable even when this Mope build does not
    // expose its world entity collection through client.map.
    addSource(client?.player?.name, client?.player ?? null);

    const collections = [
      client?.map?.entities,
      client?.map?.animals,
      client?.map?.players,
      client?.map?.entityManager?.entities,
      client?.entities,
    ];
    for (const collection of collections) {
      let values = [];
      if (collection instanceof Map) values = [...collection.values()];
      else if (Array.isArray(collection)) values = collection;
      else if (collection && typeof collection === 'object') values = Object.values(collection);
      for (const entity of values.slice(0, 1000)) {
        if (isLiveEntity(entity)) addSource(entity.name, entity);
      }
    }
    return sources;
  }

  function clanTagForName(name) {
    const key = comparableName(name);
    if (!key) return null;
    const isLocalPlayer = comparableName(state.player?.name) === key;
    // Render the local verified tag immediately. It does not depend on waiting
    // for the directory to receive the first post-spawn presence heartbeat.
    if (isLocalPlayer && state.localClanTag) return { tag: state.localClanTag, ...state.clanTagStyle };
    const entry = state.clanTagDirectory.get(key);
    if (!entry) return null;
    // The local player sees a style change immediately, before the next presence
    // heartbeat makes the same preference visible to other opted-in clients.
    return isLocalPlayer ? { ...entry, ...state.clanTagStyle } : entry;
  }

  function renderClanTags(client) {
    const timestamp = Date.now();
    if (timestamp - state.clanTagLastRenderAt < CLAN_TAG_RENDER_INTERVAL_MS) return;
    state.clanTagLastRenderAt = timestamp;
    if (!state.clanTagDirectory.size && !state.localClanTag) {
      clearClanTagVisuals();
      return;
    }
    const seen = new Set();
    for (const source of sourceEntriesForClanTags(client)) {
      const entry = clanTagForName(source.text);
      if (!entry) continue;
      seen.add(source);
      const owner = state.clanTagOwners.get(source) ?? null;
      let record = state.clanTagVisuals.get(source);
      if (!record || record.tag !== entry.tag || record.color !== entry.color) {
        if (record) removeClanTagVisual(record);
        const label = createClanTagLabel(source, entry);
        if (!label) continue;
        record = { source, owner, label, tag: entry.tag, color: entry.color, side: entry.side, topStackApplied: false, nativeNamePosition: null, nativeWinsPosition: null };
        state.clanTagVisuals.set(source, record);
      } else if (owner && record.owner !== owner) {
        uninstallClanNameStackHook(record.owner);
        record.owner = owner;
      }
      record.side = entry.side;
      placeClanTagLabel(source, record, entry);
    }
    for (const [source, record] of state.clanTagVisuals) {
      if (!seen.has(source) || !source.parent || !record.label?.parent) {
        removeClanTagVisual(record);
        state.clanTagVisuals.delete(source);
      }
    }
  }

  async function refreshClanTagDirectory() {
    const nowMs = Date.now();
    if (
      !state.installationToken ||
      state.clanTagDirectoryInFlight ||
      state.clanTagDirectoryLinkMissing ||
      nowMs - state.clanTagDirectoryLastAttemptAt < CLAN_TAG_DIRECTORY_REFRESH_MS
    ) return;
    state.clanTagDirectoryInFlight = true;
    state.clanTagDirectoryLastAttemptAt = nowMs;
    try {
      const response = await relayRequest({
        url: CLAN_TAGS_ENDPOINT,
        headers: { Authorization: `Bearer ${state.installationToken}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({}),
      });
      if (response.status >= 200 && response.status < 300) {
        const body = responseJson(response);
        const next = new Map();
        for (const player of Array.isArray(body.players) ? body.players : []) {
          const name = safeText(player?.name);
          const tag = validClanDisplayTag(player?.tag);
          const key = comparableName(name);
          if (!key || !tag || next.has(key)) continue;
          next.set(key, {
            tag,
            color: validClanTagColor(player.color) ?? DEFAULT_CLAN_TAG_STYLE.color,
            side: validClanTagSide(player.side) ?? DEFAULT_CLAN_TAG_STYLE.side,
          });
        }
        state.clanTagDirectory = next;
        state.localClanTag = validClanDisplayTag(body.selfTag);
        refreshClanTagSettingsPanel();
        return;
      }
      const relayError = responseJson(response);
      if (response.status === 403 && relayError.error === 'discord_account_not_linked') {
        state.clanTagDirectoryLinkMissing = true;
        state.clanTagDirectory.clear();
        clearClanTagVisuals();
        return;
      }
      warn(`Não foi possível atualizar as tags de clan (HTTP ${response.status}).`, relayError.error ?? response.responseText);
    } catch (error) {
      warn('Não foi possível atualizar as tags de clan.', error);
    } finally {
      state.clanTagDirectoryInFlight = false;
    }
  }

  function loadInstallationToken() {
    const stored = readStoredValue(INSTALLATION_TOKEN_STORAGE_KEY, '');
    state.installationToken = typeof stored === 'string' && /^[a-f0-9]{64}$/i.test(stored) ? stored : null;
  }

  function relayRequest({ url, headers, data }) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest indisponível'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers,
        data,
        onload: resolve,
        onerror: () => reject(new Error('Falha de rede ao chamar a API relay')),
        ontimeout: () => reject(new Error('Timeout ao chamar a API relay')),
      });
    });
  }

  function responseJson(response) {
    try {
      return JSON.parse(response.responseText || '{}');
    } catch {
      return {};
    }
  }

  async function ensureInstallation() {
    if (state.installationToken) return state.installationToken;
    if (state.installationPromise) return state.installationPromise;

    state.installationPromise = (async () => {
      const response = await relayRequest({
        url: INSTALL_ENDPOINT,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ schemaVersion: 1, source: `${TRACKER_NAME} Sensor` }),
      });
      const body = responseJson(response);
      if (response.status < 200 || response.status >= 300 || !/^[a-f0-9]{64}$/i.test(body.installationToken ?? '')) {
        throw new Error(`A API relay recusou criar a instalação (HTTP ${response.status}).`);
      }
      if (!writeStoredValue(INSTALLATION_TOKEN_STORAGE_KEY, body.installationToken)) {
        throw new Error('Não foi possível salvar o token local da instalação.');
      }
      state.installationToken = body.installationToken;
      emit('INSTALLATION_READY', { note: 'Instalação anônima criada localmente; vincule sua conta pelo botão do Discord antes de enviar arenas.' });
      return state.installationToken;
    })();

    try {
      return await state.installationPromise;
    } finally {
      state.installationPromise = null;
    }
  }

  async function completeDiscordLinkFromUrl() {
    const currentUrl = new URL(location.href);
    const ticket = currentUrl.searchParams.get(LINK_QUERY_PARAMETER);
    if (!ticket) return false;

    // Remove the one-time ticket from the visible URL and browser history immediately.
    currentUrl.searchParams.delete(LINK_QUERY_PARAMETER);
    history.replaceState(history.state, document.title, `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);

    const installationToken = await ensureInstallation();
    const response = await relayRequest({
      url: LINK_COMPLETE_ENDPOINT,
      headers: {
        Authorization: `Bearer ${installationToken}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ ticket }),
    });
    if (response.status < 200 || response.status >= 300) {
      const body = responseJson(response);
      if (response.status === 409 && body.error === 'installation_already_linked') {
        window.alert("Mope 1v1's: este navegador já está vinculado a outra conta Discord. Para usar duas contas, abra a segunda em outro perfil do navegador (ou outro navegador) e vincule lá.");
        return false;
      }
      throw new Error(`Não foi possível concluir o vínculo (HTTP ${response.status}${body.error ? `: ${body.error}` : ''}).`);
    }

    state.presenceLinkMissing = false;
    state.clanTagDirectoryLinkMissing = false;
    state.presenceLastAttemptAt = 0;
    state.clanTagDirectoryLastAttemptAt = 0;
    emit('DISCORD_ACCOUNT_LINKED', { note: 'Esta instalação foi vinculada à conta Discord que clicou no botão.' });
    window.alert("Mope 1v1's: conta Discord conectada com sucesso.");
    return true;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function safeText(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized || null;
  }

  function titleCaseSlug(value) {
    if (!value) return null;
    return value
      .split('_')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function isLiveEntity(entity) {
    return Boolean(entity && entity.type === 'animal' && entity.spawned !== false);
  }

  function animalSlug(entity) {
    if (!entity) return null;

    // Normal, non-skin texture paths contain the canonical species slug, e.g.
    // animals/land/dragon/dragon. Skins deliberately fall back to species:<id>.
    try {
      const path = typeof entity.texturePath === 'string' ? entity.texturePath : '';
      const match = path.match(/(?:^|\/)animals\/[^/]+\/([^/]+)\//);
      if (match?.[1]) {
        speciesById.set(entity.species, match[1]);
        return match[1];
      }
    } catch {
      // A future client build may remove texturePath; do not affect gameplay for that.
    }

    return speciesById.get(entity.species) ?? `species:${entity.species ?? 'unknown'}`;
  }

  function animalIconUrl(entity) {
    const texturePath = typeof entity?.texturePath === 'string' ? entity.texturePath.trim() : '';
    // Only construct a known, static asset URL from Mope's own normal-animal paths.
    // Equipped cosmetic items deliberately fall back to no thumbnail rather than
    // accepting an arbitrary URL from client state.
    const match = /^animals\/[a-z0-9_-]+\/([a-z0-9_-]+)(?:\/[a-z0-9_-]+)?\/?$/i.exec(texturePath);
    if (!match) return null;

    const basePath = texturePath.replace(/\/?$/, '/');
    return `https://mope.io/assets/${basePath}${match[1]}.ui.webp`;
  }

  function snapshotAnimal(entity, localPlayer = null) {
    if (!entity) return null;

    const slug = animalSlug(entity);

    return {
      entityId: Number.isInteger(entity.id) ? entity.id : null,
      name: safeText(entity.originalName) ?? safeText(entity.name?.text) ?? '(sem nome)',
      animal: slug,
      animalLabel: slug?.startsWith('species:') ? slug : titleCaseSlug(slug),
      animalIconUrl: animalIconUrl(entity),
      speciesId: Number.isInteger(entity.species) ? entity.species : null,
      subspeciesId: Number.isInteger(entity.subspecies) ? entity.subspecies : 0,
      tier: Number.isInteger(entity.tier) ? entity.tier : null,
      hasAccount: entity.hasAccount === true,
      skinId: safeText(entity.equippedItemId),
      arenaWins: Number.isInteger(entity.numArenaWins) ? entity.numArenaWins : null,
      isLocal: Boolean(localPlayer && entity === localPlayer),
    };
  }

  function snapshotServer(client) {
    const server = client?.network?.server;
    if (!server) return null;

    let url = safeText(server.url);
    // The URL can include a server endpoint. Keep the origin/path only; no query data is needed.
    if (url) {
      try {
        const parsed = new URL(url, location.href);
        url = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
      } catch {
        // Keep the raw value only when it is not a URL.
      }
    }

    return {
      id: safeText(server.id) ?? null,
      name: safeText(server.name) ?? null,
      regionId: safeText(server.regionId) ?? null,
      url: url ?? null,
      transport: safeText(client?.network?.protocol) ?? null,
    };
  }

  function serverFingerprint(server) {
    return server ? JSON.stringify([server.id, server.name, server.regionId, server.url, server.transport]) : null;
  }

  function snapshotPlayer(_client, player) {
    // The player object is kept only to identify the local 1v1 participant.
    // XP, rank and upgrade changes are intentionally outside this match-only sensor.
    return snapshotAnimal(player, player);
  }

  function arenaSnapshot(arena, localPlayer) {
    if (!arena) return null;
    const first = snapshotAnimal(arena.player1, localPlayer);
    const second = snapshotAnimal(arena.player2, localPlayer);
    const localIsFirst = arena.player1 === localPlayer;
    const localIsSecond = arena.player2 === localPlayer;

    return {
      arenaId: Number.isInteger(arena.id) ? arena.id : null,
      player1: first,
      player2: second,
      player1Wins: Number.isInteger(arena.player1Wins) ? arena.player1Wins : null,
      player2Wins: Number.isInteger(arena.player2Wins) ? arena.player2Wins : null,
      score1: Number.isInteger(arena.score1) ? arena.score1 : null,
      score2: Number.isInteger(arena.score2) ? arena.score2 : null,
      message: safeText(arena.message?.text),
      localSlot: localIsFirst ? 1 : localIsSecond ? 2 : null,
      localScore: localIsFirst ? arena.score1 : localIsSecond ? arena.score2 : null,
      opponentScore: localIsFirst ? arena.score2 : localIsSecond ? arena.score1 : null,
    };
  }

  function opponentFromArena(snapshot) {
    if (!snapshot) return null;
    return snapshot.localSlot === 1 ? snapshot.player2 : snapshot.localSlot === 2 ? snapshot.player1 : null;
  }

  function comparableName(value) {
    return safeText(value)?.normalize('NFC').toLocaleLowerCase() ?? null;
  }

  function base64DataUrlToBlob(dataUrl) {
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;

    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: match[1] });
  }

  async function captureArenaScreenshot(client) {
    try {
      /*
       * Do not export the whole `stage`: its bounds include the large game world and
       * can exceed the GPU texture/renderbuffer limit. Export only renderer.screen,
       * at a deliberately small resolution, and only once after a final result signal.
       * Direct canvas.toBlob() remains unsuitable because WebGL may have cleared it.
       */
      const renderer = client?.loop?.renderer;
      const stage = client?.loop?.stage;
      const frame = renderer?.screen;
      if (
        !renderer?.extract?.base64 ||
        !stage ||
        !frame ||
        typeof frame.copyTo !== 'function' ||
        !Number.isFinite(frame.width) ||
        !Number.isFinite(frame.height) ||
        frame.width <= 0 ||
        frame.height <= 0
      ) {
        return null;
      }

      const widthLimitedResolution = SCREENSHOT_MAX_OUTPUT_WIDTH / frame.width;
      const heightLimitedResolution = SCREENSHOT_MAX_OUTPUT_HEIGHT / frame.height;
      const resolution = Math.min(SCREENSHOT_PREFERRED_RESOLUTION, widthLimitedResolution, heightLimitedResolution);
      if (!Number.isFinite(resolution) || resolution <= 0) return null;
      const dataUrl = await renderer.extract.base64({
        target: stage,
        frame,
        resolution,
        format: 'jpg',
        quality: 0.92,
      });
      const blob = base64DataUrlToBlob(dataUrl);
      return blob && blob.size > 0 ? blob : null;
    } catch (error) {
      warn('Não foi possível extrair o frame final reduzido da arena.', error);
      return null;
    }
  }

  function queueArenaScreenshot(active, client) {
    // A match gets one best-effort capture. Never start parallel GPU readbacks.
    // Waiting a moment keeps the final blow/result animation out of the screenshot.
    if (active.screenshotPromise) return active.screenshotPromise;
    const task = sleep(SCREENSHOT_FINAL_DELAY_MS)
      .then(() => captureArenaScreenshot(client))
      .then((blob) => {
        if (blob) active.screenshot = blob;
        return blob;
      });
    active.screenshotPromise = task;
    return task;
  }

  function emptyStats() {
    return { version: 2, winStreak: 0, confrontos: {}, history: [] };
  }

  function h2hKey(localName, opponentName) {
    const localKey = comparableName(localName) ?? 'unknown-local';
    const opponentKey = comparableName(opponentName) ?? 'unknown-opponent';
    return `${localKey}::${opponentKey}`;
  }

  function isCountedLocalWin(result) {
    // The final embed still labels candidate wins as “em validação”, but the local
    // H2H should reflect the arena-win signal immediately instead of staying 0 × 0.
    return result === 'VICTORY_CONFIRMED' || result === 'VICTORY_CANDIDATE';
  }

  function rebuildConfrontos(history) {
    const confrontos = {};
    for (const item of [...history].reverse()) {
      if (!item || typeof item !== 'object') continue;
      const localName = safeText(item.localName) ?? 'Jogador local';
      const opponentName = safeText(item.opponentName) ?? 'Desconhecido';
      const key = h2hKey(localName, opponentName);
      const h2h = confrontos[key] ?? {
        localName,
        opponentName,
        wins: 0,
        losses: 0,
        unknown: 0,
      };
      if (isCountedLocalWin(item.result)) h2h.wins += 1;
      else if (item.result === 'DEFEAT_CONFIRMED') h2h.losses += 1;
      else h2h.unknown += 1;
      confrontos[key] = h2h;
    }
    return confrontos;
  }

  function loadStats() {
    const value = readStoredValue(STATS_STORAGE_KEY, emptyStats());
    if (!value || typeof value !== 'object') return emptyStats();
    const history = Array.isArray(value.history) ? value.history.slice(0, MAX_MATCH_HISTORY) : [];
    const needsH2HMigration = value.version !== 2;
    return {
      version: 2,
      winStreak: Number.isInteger(value.winStreak) ? value.winStreak : 0,
      confrontos: needsH2HMigration ? rebuildConfrontos(history) : value.confrontos && typeof value.confrontos === 'object' ? value.confrontos : {},
      history,
    };
  }

  function updateLocalStats(match) {
    const stats = loadStats();
    const opponentName = match.opponent?.name ?? 'Desconhecido';
    const key = h2hKey(match.local.name, opponentName);
    const h2h = stats.confrontos[key] ?? {
      localName: match.local.name,
      opponentName,
      wins: 0,
      losses: 0,
      unknown: 0,
    };

    if (isCountedLocalWin(match.result)) {
      h2h.wins += 1;
      stats.winStreak += 1;
    } else if (match.result === 'DEFEAT_CONFIRMED') {
      h2h.losses += 1;
      stats.winStreak = 0;
    } else {
      h2h.unknown += 1;
    }

    stats.confrontos[key] = h2h;
    stats.history.unshift({
      at: new Date().toISOString(),
      localName: match.local.name,
      opponentName: match.opponent?.name ?? 'Desconhecido',
      localScore: match.localScore,
      opponentScore: match.opponentScore,
      result: match.result,
      durationMs: match.durationMs,
    });
    stats.history = stats.history.slice(0, MAX_MATCH_HISTORY);
    writeStoredValue(STATS_STORAGE_KEY, stats);
    return { winStreak: stats.winStreak, h2h };
  }

  function buildRelayEnvelope(match, stats, screenshot) {
    return {
      schemaVersion: 1,
      source: `${TRACKER_NAME} Sensor`,
      occurredAt: now(),
      match: {
        arenaId: match.arenaId,
        result: match.result,
        // The relay only needs display names; do not send entity/account/animal fields.
        local: { name: match.local.name },
        opponent: match.opponent ? { name: match.opponent.name } : null,
        localScore: match.localScore,
        opponentScore: match.opponentScore,
        durationMs: match.durationMs,
      },
      // This is browser-local, informational data. The relay must not treat it as
      // authoritative for rankings or permissions.
      localStats: {
        h2h: {
          localName: stats.h2h.localName,
          opponentName: stats.h2h.opponentName,
          wins: stats.h2h.wins,
          losses: stats.h2h.losses,
          unknown: stats.h2h.unknown,
        },
      },
      screenshot: screenshot
        ? { field: 'screenshot', filename: 'arena.jpg', contentType: 'image/jpeg' }
        : null,
    };
  }

  async function sendMatchToRelay(envelope, screenshot, match) {
    const installationToken = await ensureInstallation();
    const body = new FormData();
    body.append('payload_json', JSON.stringify(envelope));
    if (screenshot) body.append('screenshot', screenshot, 'arena.jpg');

    const response = await relayRequest({
      url: RELAY_ENDPOINT,
      headers: { Authorization: `Bearer ${installationToken}` },
      data: body,
    });
    if (response.status >= 200 && response.status < 300) {
      emit('MATCH_RELAY_SENT', {
        arenaId: match.arenaId,
        result: match.result,
        screenshotAttached: Boolean(screenshot),
        status: response.status,
      });
      return;
    }

    const relayError = responseJson(response);
    if (response.status === 403 && relayError.error === 'discord_account_not_linked') {
      warn('Esta instalação ainda não está vinculada ao Discord. No canal de conexão, clique em “Conectar meu Mope” e depois em “Abrir Mope e conectar”.');
      return;
    }
    warn(`A API relay respondeu HTTP ${response.status}; a partida não foi encaminhada.`, relayError.error ?? response.responseText);
  }

  async function publishMatchToRelay(match, active) {
    // Keep the cached frame, but let the final visual animation settle before asking
    // the relay to publish it. This delay does not touch rendering or gameplay.
    await sleep(RELAY_POST_END_DELAY_MS);

    // Capture is only requested while the arena is still present, after a final-result
    // signal. Do not initiate a new WebGL extraction after the arena has disappeared.
    let screenshot = active.screenshot ?? null;
    if (!screenshot && active.screenshotPromise) screenshot = await active.screenshotPromise;
    if (!screenshot) warn('Screenshot da arena indisponível; o resumo será encaminhado sem imagem.');

    const stats = updateLocalStats(match);
    const envelope = buildRelayEnvelope(match, stats, screenshot);
    await sendMatchToRelay(envelope, screenshot, match);
  }

  function clientLooksValid(candidate) {
    return Boolean(
      candidate &&
        typeof candidate === 'object' &&
        candidate.network &&
        candidate.animalStats &&
        candidate.classes?.global &&
        candidate.loop &&
        candidate.map,
    );
  }

  function candidateModuleUrls() {
    const urls = new Set();

    for (const link of document.querySelectorAll('link[rel="modulepreload"][href]')) {
      try {
        const url = new URL(link.href, location.href);
        if (url.origin === location.origin && url.pathname.endsWith('.js')) urls.add(url.href);
      } catch {
        // Ignore malformed preload links.
      }
    }

    for (const entry of performance.getEntriesByType('resource')) {
      try {
        const url = new URL(entry.name, location.href);
        if (url.origin === location.origin && url.pathname.endsWith('.js')) urls.add(url.href);
      } catch {
        // Ignore non-URL performance entries.
      }
    }

    return [...urls];
  }

  async function discoverClient() {
    const tried = new Set();
    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
      for (const url of candidateModuleUrls()) {
        if (tried.has(url)) continue;
        tried.add(url);

        try {
          // This imports an already-loaded module from the same page origin. It never calls a
          // mope.io function; it only receives the module namespace and finds the existing client.
          const moduleNamespace = await import(url);
          for (const value of Object.values(moduleNamespace)) {
            if (clientLooksValid(value)) return { client: value, url };
          }
        } catch {
          // Some preload chunks are not the game client. They are intentionally skipped.
        }
      }
      await sleep(300);
    }

    return null;
  }

  function decodeStopGameSession(buffer) {
    try {
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 24) return null;

      const view = new DataView(buffer);
      if (view.getUint8(0) !== CURRENT_STOP_GAME_SESSION_PREFIX) return null;

      let offset = 1;
      const need = (length) => {
        if (offset + length > view.byteLength) throw new RangeError('buffer truncated');
      };
      const u8 = () => {
        need(1);
        const value = view.getUint8(offset);
        offset += 1;
        return value;
      };
      const u16 = () => {
        need(2);
        const value = view.getUint16(offset, true);
        offset += 2;
        return value;
      };
      const u32 = () => {
        need(4);
        const value = view.getUint32(offset, true);
        offset += 4;
        return value;
      };
      const string = () => {
        const length = u16();
        need(length);
        const value = new TextDecoder().decode(new Uint8Array(buffer, offset, length));
        offset += length;
        return value;
      };

      const result = {
        xp: u32(),
        timeAliveMs: u32(),
        kills: u32(),
        wins: u32(),
        coinsEarned: u32(),
        cause: u8(),
        killerName: string(),
        killerAnimalSpeciesId: u16(),
        killerSubspeciesId: u8(),
        killerSkinId: string(),
        via: u8(),
        viaId: u8(),
        castByName: string(),
        castByAnimalSpeciesId: u16(),
      };

      // The exact final offset is an important guard against accidentally decoding another packet.
      if (offset !== view.byteLength) return null;

      const causeNames = ['ENVIRONMENT', 'PLAYER', 'ANIMAL', 'RESOURCE'];
      result.causeName = causeNames[result.cause] ?? `UNKNOWN_${result.cause}`;
      result.killerAnimal = speciesById.get(result.killerAnimalSpeciesId) ?? `species:${result.killerAnimalSpeciesId}`;
      result.castByAnimal = speciesById.get(result.castByAnimalSpeciesId) ?? `species:${result.castByAnimalSpeciesId}`;
      return result;
    } catch {
      return null;
    }
  }

  function observeMessage(event) {
    const stopSession = decodeStopGameSession(event.data);
    if (!stopSession) return;

    state.lastStopSession = { ...stopSession, at: Date.now() };
    if (!state.arena) return; // This is a 1v1-only sensor: ignore ordinary deaths.

    const arena = state.arena.last;
    const opponent = opponentFromArena(arena);
    const opponentMatchesKiller =
      stopSession.causeName === 'PLAYER' &&
      comparableName(opponent?.name) !== null &&
      comparableName(opponent?.name) === comparableName(stopSession.killerName);

    state.arena.defeatConfirmed = opponentMatchesKiller;
    state.arena.defeatEvidence = stopSession;
    // One reduced capture after the final death signal, before the next render replaces the arena.
    void queueArenaScreenshot(state.arena, state.client);

    emit(opponentMatchesKiller ? '1V1_DEFEAT' : '1V1_DEFEAT_CANDIDATE', {
      arena,
      opponent,
      gameSessionStop: stopSession,
      confidence: opponentMatchesKiller
        ? 'confirmed — the current arena opponent matches the PLAYER killer in stopGameSession'
        : 'candidate — life ended while a local arena was active, but the killer could not be matched safely',
    });
  }

  function observeSocket(client) {
    const socket = client?.network?.socket;
    if (socket === state.transport.socket) return;

    state.transport.socket = socket ?? null;
    state.transport.readyState = null;

    if (!socket) return;

    if (typeof socket.addEventListener === 'function') {
      // Additive listener only. It does not stop propagation or alter the packet.
      socket.addEventListener('message', observeMessage);
      socket.addEventListener('close', (event) => {
        emit('TRANSPORT_CLOSED', { code: event.code, reason: event.reason || null, clean: event.wasClean });
      });
      socket.addEventListener('open', () => emit('TRANSPORT_OPEN', snapshotServer(client) ?? {}));
      emit('TRANSPORT_OBSERVED', { kind: 'WebSocket', server: snapshotServer(client) });
    } else {
      // WebTransport is not patched. State polling below continues to work with it.
      emit('TRANSPORT_OBSERVED', { kind: 'non-WebSocket transport', server: snapshotServer(client) });
    }
  }

  function monitorServer(client) {
    const server = snapshotServer(client);
    const fingerprint = serverFingerprint(server);
    if (fingerprint !== state.serverKey) {
      state.serverKey = fingerprint;
      if (server) {
        console.log(`${LG_PREFIX} Server: ${server.name ?? server.id ?? '(unknown)'}`, server);
        emit('SERVER_DETECTED', server);
      }
    }

  }

  function presenceFingerprint(player) {
    return player ? JSON.stringify([player.name, player.animalLabel]) : null;
  }

  async function publishPresence(player) {
    if (!player || !state.installationToken || state.presenceInFlight || state.presenceLinkMissing) return;

    const fingerprint = presenceFingerprint(player);
    const nowMs = Date.now();
    const changed = fingerprint !== state.presenceLastFingerprint;
    if (!changed && nowMs - state.presenceLastAttemptAt < PRESENCE_HEARTBEAT_MS) return;

    state.presenceInFlight = true;
    state.presenceLastAttemptAt = nowMs;
    try {
      const response = await relayRequest({
        url: PRESENCE_ENDPOINT,
        headers: {
          Authorization: `Bearer ${state.installationToken}`,
          'Content-Type': 'application/json',
        },
        data: JSON.stringify({
          player: { name: player.name, animal: player.animalLabel, animalIconUrl: player.animalIconUrl },
          clanTag: state.clanTagStyle,
        }),
      });
      if (response.status >= 200 && response.status < 300) {
        state.presenceLastFingerprint = fingerprint;
        // Refresh right after publishing the current name, so tags become visible
        // in this same session instead of waiting for the normal directory interval.
        state.clanTagDirectoryLastAttemptAt = 0;
        void refreshClanTagDirectory();
        return;
      }

      const relayError = responseJson(response);
      if (response.status === 403 && relayError.error === 'discord_account_not_linked') {
        // Do not retry an anonymous installation every tick. A successful `.link`
        // resets this flag and starts presence reporting immediately afterwards.
        state.presenceLinkMissing = true;
        return;
      }
      warn(`A presença não foi atualizada (HTTP ${response.status}).`, relayError.error ?? response.responseText);
    } catch (error) {
      warn('Não foi possível atualizar a presença do jogador.', error);
    } finally {
      state.presenceInFlight = false;
    }
  }

  function monitorPlayer(client) {
    const rawPlayer = isLiveEntity(client?.player) ? client.player : null;
    const current = rawPlayer ? snapshotPlayer(client, rawPlayer) : null;

    // Keep the current local entity fresh for the 1v1 snapshot, without producing
    // progression noise for XP, animal upgrades, respawns or ordinary deaths.
    if (!state.player && current) state.lastStopSession = null;
    state.player = current;
    if (current?.name) state.lastKnownPlayerName = current.name;
    updateClanTagSettingsVisibility();
    void publishPresence(current);
    void refreshClanTagDirectory();
    renderClanTags(client);
  }

  function monitorArena(client) {
    const local = client.player;
    const rawArena = local?.arena ?? null;
    const active = state.arena;

    if (!active && rawArena) {
      state.arena = {
        ref: rawArena,
        startedAt: Date.now(),
        announced: false,
        last: arenaSnapshot(rawArena, local),
        localArenaWinsAtStart: Number.isInteger(local?.numArenaWins) ? local.numArenaWins : null,
        victoryCounterObserved: false,
        defeatConfirmed: false,
        defeatEvidence: null,
      };
      return;
    }

    // The client can replace the arena object while retaining the same arena id.
    // A reference replacement alone is not an arena end; keep tracking that same match.
    if (active && rawArena && rawArena !== active.ref) {
      const replacementId = Number.isInteger(rawArena.id) ? rawArena.id : null;
      if (replacementId !== null && replacementId === active.last?.arenaId) active.ref = rawArena;
    }

    if (active && rawArena === active.ref) {
      const current = arenaSnapshot(rawArena, local);
      const previous = active.last;
      active.last = current;

      // Entity creation can be split over updates. Wait briefly so both participants have names.
      const participantsReady = Boolean(current?.player1 && current?.player2);
      if (!active.announced && (participantsReady || Date.now() - active.startedAt > 1500)) {
        active.announced = true;
        const opponent = opponentFromArena(current);
        emit('1V1_START', {
          arena: current,
          player: state.player,
          opponent,
          server: snapshotServer(client),
        });
      }

      if (previous && (previous.score1 !== current?.score1 || previous.score2 !== current?.score2)) {
        // Score changes are telemetry only. Never capture/export WebGL during a live fight.
        emit('1V1_SCORE_CHANGED', {
          arenaId: current.arenaId,
          player: state.player,
          opponent: opponentFromArena(current),
          previousLocalScore: previous.localScore,
          previousOpponentScore: previous.opponentScore,
          localScore: current.localScore,
          opponentScore: current.opponentScore,
        });
      }

      const currentWins = Number.isInteger(local?.numArenaWins) ? local.numArenaWins : null;
      if (
        active.localArenaWinsAtStart !== null &&
        currentWins !== null &&
        currentWins > active.localArenaWinsAtStart
      ) {
        emit('1V1_VICTORY_CANDIDATE', {
          arena: current,
          previousArenaWins: active.localArenaWinsAtStart,
          currentArenaWins: currentWins,
          confidence: 'candidate — the local arena-win counter increased during the active arena; real-match validation required',
        });
        // One reduced capture after a final-result signal, never on a normal bite.
        void queueArenaScreenshot(active, client);
        // Avoid repeating this event on subsequent polling cycles while retaining the evidence
        // for the final 1V1_END event.
        active.victoryCounterObserved = true;
        active.localArenaWinsAtStart = currentWins;
      }
      return;
    }

    if (active && rawArena !== active.ref) {
      const finalArena = active.last;
      const localAlive = isLiveEntity(client.player);
      const localWinsNow = Number.isInteger(client.player?.numArenaWins) ? client.player.numArenaWins : null;
      const winCounterIncreased =
        active.victoryCounterObserved ||
        (active.localArenaWinsAtStart !== null && localWinsNow !== null && localWinsNow > active.localArenaWinsAtStart);
      const result = active.defeatConfirmed
        ? 'DEFEAT_CONFIRMED'
        : winCounterIncreased
          ? 'VICTORY_CANDIDATE'
          : !localAlive && state.lastStopSession
            ? 'DEFEAT_CANDIDATE'
            : 'UNKNOWN_OR_CANCELLED';

      const localParticipant = finalArena?.localSlot === 1 ? finalArena.player1 : finalArena?.localSlot === 2 ? finalArena.player2 : null;
      const opponent = opponentFromArena(finalArena);
      const match = {
        arenaId: finalArena?.arenaId ?? null,
        local: localParticipant ?? state.player ?? { name: 'Jogador local' },
        opponent,
        localScore: finalArena?.localScore ?? null,
        opponentScore: finalArena?.opponentScore ?? null,
        durationMs: Date.now() - active.startedAt,
        result,
      };

      emit('1V1_END', {
        arena: finalArena,
        ...match,
        localPlayerStillExists: localAlive,
        localArenaWinCounterIncreased: winCounterIncreased,
        defeatEvidence: active.defeatEvidence,
        resultNote:
          result === 'DEFEAT_CONFIRMED'
            ? 'Confirmed by stopGameSession: the PLAYER killer name matches the opponent captured in this arena.'
            : 'Victory still depends on a counter-based inference; validate a real victory before using it for stats or alerts.',
      });
      state.arena = null;
      void publishMatchToRelay(match, active).catch((error) => {
        warn('Falha ao preparar o envio da partida para a API relay.', error);
      });
    }
  }

  function tick() {
    const client = state.client;
    if (!client) return;

    try {
      observeSocket(client);
      monitorServer(client);
      monitorPlayer(client);
      monitorArena(client);
    } catch (error) {
      // A reading error must never interfere with the game loop.
      warn('Erro de leitura ignorado pelo sensor.', error);
    }
  }

  async function boot() {
    installClanTagSettingsPanel();
    emit('SENSOR_BOOT', {
      location: location.origin,
      note: 'Modo somente leitura. O envio opcional usa somente a API relay oficial fixa; nenhuma ação de jogo é automatizada.',
    });

    const discovered = await discoverClient();
    if (!discovered) {
      warn('Não foi possível localizar a instância do cliente nesta build. O jogo não foi alterado. Recarregue e verifique o console.');
      emit('CLIENT_DISCOVERY_FAILED', {
        note: 'Os módulos ou a estrutura interna do cliente podem ter mudado. Nenhum fallback invasivo foi usado.',
      });
      return;
    }

    state.client = discovered.client;
    state.clientModuleUrl = discovered.url;

    emit('MOPE_CLIENT_LOADED', {
      moduleUrl: new URL(discovered.url).pathname,
      gameVersion: safeText(discovered.client?.config?.gameVersion) ?? null,
      protocolVersion: safeText(discovered.client?.config?.protocolVersion) ?? null,
      note: 'Estado do cliente localizado por capacidade; não há uma API global pública assumida.',
    });

    // Small local API for a future opt-in transport adapter. It is not a mope.io API.
    window.Mope1v1s = Object.freeze({
      version: VERSION,
      onEvent(callback) {
        if (typeof callback !== 'function') throw new TypeError('Mope1v1s.onEvent espera uma função.');
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      getSnapshot() {
        return plain({
          player: state.player,
          server: snapshotServer(state.client),
          arena: state.arena?.last ?? null,
        });
      },
      installationReady: () => Boolean(state.installationToken),
      // The anonymous installation token is never exposed through this page API.
    });

    tick();
    state.timer = window.setInterval(tick, POLL_INTERVAL_MS);
  }

  function scheduleBoot() {
    // Waiting for load avoids evaluating/preloading the game's module graph early.
    if (document.readyState === 'complete') {
      void boot();
    } else {
      window.addEventListener('load', () => void boot(), { once: true });
    }
  }

  loadClanTagStyle();
  loadInstallationToken();
  void ensureInstallation().catch((error) => warn('Não foi possível preparar a instalação automática.', error));
  void completeDiscordLinkFromUrl().catch((error) => warn('Não foi possível concluir o vínculo com o Discord.', error));
  scheduleBoot();
})();
