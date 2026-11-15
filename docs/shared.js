'use strict';
/* 2301桌游共享前端工具：API、会话、提示、牌面、声音、状态同步。 */
(function () {
  const API_BASE = (window.DANDONG_API_BASE || '').replace(/\/+$/, '');
  const ASSET_PREFIX = window.DANDONG_ASSET_PREFIX || '/assets/';
  const FACE_V = '?v=4';
  const jokerFaces = {
    small: ASSET_PREFIX + 'joker-small.svg' + FACE_V,
    big: ASSET_PREFIX + 'joker-big.svg' + FACE_V,
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const toast = (() => {
    let timer = null;
    return function notice(m) {
      const t = document.querySelector('#toast');
      if (!t) return;
      t.textContent = m;
      t.style.opacity = 1;
      clearTimeout(timer);
      timer = setTimeout(() => { t.style.opacity = 0; }, 2200);
    };
  })();

  function myNotice(m) {
    const el = document.querySelector('#myNotice');
    if (!el) return toast(m);
    el.textContent = m;
    el.classList.add('show');
    clearTimeout(myNotice.timer);
    myNotice.timer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  async function api(path, data = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let r;
    try {
      r = await fetch(API_BASE + '/api/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data || {}),
        signal: ctrl.signal,
      });
    } catch {
      const err = new Error('网络不稳定，请稍后重试');
      err.code = 'network';
      throw err;
    } finally {
      clearTimeout(timer);
    }
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok || j.error) {
      const err = new Error(j.error || '操作失败');
      err.code = j.code || '';
      err.status = r.status;
      throw err;
    }
    return j;
  }

  function session(key) {
    return {
      save(obj) {
        try { localStorage.setItem(key, JSON.stringify(obj)); } catch {}
      },
      load() {
        try {
          const s = JSON.parse(localStorage.getItem(key) || 'null');
          if (s && typeof s.room === 'string' && typeof s.token === 'string') return s;
        } catch {}
        return null;
      },
      clear() {
        try { localStorage.removeItem(key); } catch {}
      },
    };
  }

  /* ---------- 牌面 ---------- */

  const SUIT_CHAR = ['♠', '♥', '♣', '♦'];
  const SUIT_KEY = { 0: 's', 1: 'h', 2: 'c', 3: 'd' };
  const RANK_KEY = { 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: '11', 12: '12', 13: '13', 14: '14', 15: '15' };
  const RANK_LABEL = { 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' };

  function suitChar(c) {
    return c.rank >= 16 ? (c.rank === 17 ? '★' : '✦') : SUIT_CHAR[c.suit];
  }

  function rankLabel(rank) {
    return RANK_LABEL[rank] || String(rank);
  }

  function cardHTML(c, opts = {}) {
    if (!c) return '';
    const selected = opts.selected ? 'selected' : '';
    const animate = opts.animate ? 'new-move' : '';
    const role = opts.role ? ` ${opts.role}` : '';
    const badge = opts.badge ? `<span class="card-tag">${esc(opts.badge)}</span>` : '';
    if (c.rank >= 16) {
      const alt = c.rank === 17 ? '大王' : '小王';
      return `<div class="card joker-face ${selected} ${animate}${role}" data-id="${c.id}">${badge}<img class="joker-art" src="${c.rank === 17 ? jokerFaces.big : jokerFaces.small}" alt="${alt}"></div>`;
    }
    const src = `${ASSET_PREFIX}card-${SUIT_KEY[c.suit]}-${RANK_KEY[c.rank]}.svg` + FACE_V;
    return `<div class="card card-face ${selected} ${animate}${role}" data-id="${c.id}">${badge}<img class="card-img" src="${src}" alt="${rankLabel(c.rank)}${suitChar(c)}" draggable="false"></div>`;
  }

  const PRELOADED_FACES = [];
  let preloaded = false;
  function preloadCardFaces() {
    if (preloaded) return;
    preloaded = true;
    const srcs = [jokerFaces.small, jokerFaces.big];
    for (const suit of Object.values(SUIT_KEY)) {
      for (const rank of Object.values(RANK_KEY)) srcs.push(`${ASSET_PREFIX}card-${suit}-${rank}.svg` + FACE_V);
    }
    for (const src of srcs) {
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
      PRELOADED_FACES.push(img);
    }
  }

  /* ---------- 声音 ---------- */

  const audio = (() => {
    let ctx = null;
    let muted = false;
    try { muted = localStorage.getItem('dandong50k-muted') === '1'; } catch {}
    function ensure() {
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
      } catch {}
    }
    function beep(kind) {
      if (muted) return;
      try {
        ensure();
        if (!ctx) return;
        const now = ctx.currentTime;
        const freqs = kind === 'turn' ? [660, 880] : kind === 'warn' ? [440, 440] : [523, 659, 784];
        freqs.forEach((f, i) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'sine';
          o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, now + i * 0.12);
          g.gain.exponentialRampToValueAtTime(0.09, now + i * 0.12 + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.13);
          o.connect(g).connect(ctx.destination);
          o.start(now + i * 0.12);
          o.stop(now + i * 0.12 + 0.15);
        });
      } catch {}
    }
    return {
      ensure,
      beep,
      isMuted: () => muted,
      toggle() {
        muted = !muted;
        try { localStorage.setItem('dandong50k-muted', muted ? '1' : '0'); } catch {}
        if (!muted) { ensure(); beep('turn'); }
        return muted;
      },
    };
  })();

  /* ---------- 实时状态同步（WS + 轮询兜底） ---------- */

  function wsUrl() {
    if (API_BASE) {
      const u = new URL(API_BASE);
      return (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host + '/ws';
    }
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }

  // opts: { onState(state, serverNow), onBanner(text, warn), onClosed(), onRemoved(reason), onAuthFail(err), onHello(seat) }
  function createClient(opts = {}) {
    let ws = null;
    let wsState = 'idle';
    let retry = 0;
    let retryTimer = null;
    let pollTimer = null;
    let watch = null;
    let lastMessage = 0;
    let roomId = '';
    let token = '';

    function banner(text, warn) { if (opts.onBanner) opts.onBanner(text, warn); }

    function startPolling() {
      if (pollTimer || !roomId || !token) return;
      pollTimer = setInterval(async () => {
        try {
          const r = await api('state', { room: roomId, token });
          if (opts.onState) opts.onState(r.state, r.serverNow);
        } catch (e) {
          if (e.code === 'auth' && roomId && token && opts.onAuthFail) opts.onAuthFail(e);
        }
      }, 850);
    }
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
    function scheduleReconnect() {
      if (retryTimer || !roomId || !token) return;
      const wait = Math.min(8000, 500 * Math.pow(2, retry)) + Math.random() * 300;
      retry += 1;
      retryTimer = setTimeout(() => { retryTimer = null; connect(); }, wait);
    }
    function connect() {
      if (!roomId || !token) return;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      clearTimeout(retryTimer);
      retryTimer = null;
      clearTimeout(watch);
      wsState = 'connecting';
      banner('', false);
      let sock;
      try {
        sock = new WebSocket(wsUrl());
      } catch {
        wsState = 'closed';
        startPolling();
        scheduleReconnect();
        return;
      }
      ws = sock;
      watch = setTimeout(() => { if (wsState !== 'open') startPolling(); }, 4000);
      sock.onopen = () => {
        lastMessage = Date.now();
        try { sock.send(JSON.stringify({ type: 'hello', room: roomId, token })); } catch {}
      };
      sock.onmessage = (ev) => {
        lastMessage = Date.now();
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (!m || typeof m !== 'object') return;
        if (m.type === 'hello') {
          if (m.ok) {
            wsState = 'open';
            retry = 0;
            clearTimeout(watch);
            stopPolling();
            if (opts.onHello) opts.onHello(m.seat);
            if (opts.onState) opts.onState(m.state, m.serverNow);
            banner('', false);
          } else if (roomId && token && opts.onAuthFail) {
            opts.onAuthFail(new Error(m.message || '身份验证失败，请重新加入'));
          }
          return;
        }
        if (m.type === 'state') {
          wsState = 'open';
          if (opts.onState) opts.onState(m.state, m.serverNow);
          return;
        }
        if (m.type === 'removed') {
          if (opts.onRemoved) opts.onRemoved(m.reason);
          return;
        }
        if (m.type === 'closed') {
          if (opts.onClosed) opts.onClosed();
        }
      };
      sock.onclose = () => {
        if (ws === sock) ws = null;
        clearTimeout(watch);
        wsState = 'closed';
        if (!token) return;
        startPolling();
        banner('已断线，正在重连 · 轮询同步中', true);
        scheduleReconnect();
      };
      sock.onerror = () => { try { sock.close(); } catch {} };
    }

    function close() {
      try { if (ws) ws.close(); } catch {}
      ws = null;
      wsState = 'idle';
      roomId = '';
      token = '';
      retry = 0;
      stopPolling();
      clearTimeout(retryTimer);
      retryTimer = null;
      clearTimeout(watch);
    }

    function sync(room, authToken) {
      roomId = room;
      token = authToken;
      connect();
    }

    const pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (Date.now() - lastMessage > 45000) { try { ws.close(); } catch {} }
        else { try { ws.send(JSON.stringify({ type: 'ping' })); } catch {} }
      }
    }, 20000);
    if (pingTimer.unref) pingTimer.unref();

    return {
      sync,
      connect,
      close,
      startPolling,
      stopPolling,
      isOpen: () => wsState === 'open',
      get roomId() { return roomId; },
      get token() { return token; },
    };
  }

  window.DD = {
    API_BASE,
    ASSET_PREFIX,
    jokerFaces,
    esc,
    notice: toast,
    myNotice,
    api,
    session,
    suitChar,
    rankLabel,
    cardHTML,
    preloadCardFaces,
    audio,
    wsUrl,
    createClient,
  };
})();
