'use strict';

// Rave TMA — клиентская логика
// Архитектура Rave: Server-side Master Clock + Dynamic Playback Rate

window.currentRoomId = null;

const SYNC_THRESHOLD_SECONDS = 2;

const SOURCE_TYPES = {
  YOUTUBE: 'youtube',
  VIMEO: 'vimeo',
  HLS: 'hls',
  NATIVE: 'native',
  IFRAME: 'iframe',
  UNKNOWN: 'unknown'
};

let isSyncing = false;
let currentPlaybackRate = 1.0;

const state = {
  socket: null,
  roomId: '',
  connected: false,

  currentType: SOURCE_TYPES.UNKNOWN,
  currentUrl: '',

  ytReady: false,
  ytPlayer: null,
  ytPlayerReady: false,
  ytApiLoaded: false,

  peers: [],
  viewers: 1,

  userName: 'Гость',
  userId: null,

  messages: [],
  replyTo: null,

  reactions: {},
  recentReactions: JSON.parse(localStorage.getItem('recent_reactions')) || ['❤️', '💖', '😻', '🥰', '😂'],

  isHost: null,
  queue: [],
  serverTimeOffsetMs: 0,
  serverPingMs: 0,
  clockSyncInterval: null,

  isPlaying: false,
};

let snackbarEl = null;
let snackbarTimer = null;

const $ = (sel) => document.querySelector(sel);

const els = {
  roomBadge: $('#roomBadge'),
  connStatus: $('#connStatus'),
  connText: $('#connText'),

  changeMediaBtn: $('#changeMediaBtn'),
  inviteBtn: $('#inviteBtnHeader'),
  peersBtn: $('#peersBtnHeader'),
  peersCount: $('#peersCountHeader'),

  diagRoomState: $('#diagRoomState'),
  diagUrl: $('#diagUrl'),
  diagType: $('#diagType'),
  diagStatus: $('#diagStatus'),

  playerRenderLayer: $('#player-render-layer'),
  ravePlayBtn: $('#rave-play-btn'),
  raveProgressFill: $('#rave-progress-fill'),
  raveTimeDisplay: $('#rave-time-display'),
  raveProgressContainer: $('#rave-progress-container'),
  nowPlayingTitle: $('#nowPlayingTitle'),

  chatMessages: $('#chatMessages'),
  chatEmpty: $('#chatEmpty'),
  chatInput: $('#chatInput'),
  chatSendBtn: $('#chatSendBtn'),

  mediaDrawer: $('#mediaDrawer'),
  drawerCloseBtn: $('#drawerCloseBtn'),
  drawerOverlay: $('#drawerOverlay'),
  drawerPeers: $('#drawerPeers'),
  urlInput: $('#urlInput'),
  loadBtn: $('#loadBtn'),
  presetRow: $('#presetRow'),
  joinCodeInput: $('#joinCodeInput'),
  joinCodeBtn: $('#joinCodeBtn'),
  myRoomCode: $('#myRoomCode'),

  loadingOverlay: $('#loadingOverlay'),
  loadingText: $('#loadingText'),

  roomViewScreen: $('#room-view-screen'),
};

// ═══════════════════════════════════════════════════════════
// RavePlayerEngine — универсальный движок плеера
// ═══════════════════════════════════════════════════════════

class RavePlayerEngine {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.type = null; // 'yt' | 'native'
    this.instance = null; // YT.Player | HTMLVideoElement
    this.isReady = false;
    this.duration = 0;
  }

  load(url) {
    this.isReady = false;
    this.pendingPlay = false;
    this.duration = 0;
    this.container.innerHTML = '';
    const ytId = this.extractYTId(url);

    if (ytId) {
      this.type = 'yt';
      this._loadYouTube(ytId);
    } else {
      this.type = 'native';
      this._loadNative(url);
    }
  }

  _loadYouTube(videoId) {
    // Если плеер уже создан для этого видео — не создаём заново
    if (this.instance && this.type === 'yt') {
      try {
        if (this.instance.getVideoData()?.video_id === videoId) return;
      } catch (e) {}
    }

    this._pendingYTVideoId = videoId;

    if (!window.YT) {
      showLoading('Загрузка YouTube API…');
      return;
    }

    this._createYTPlayer(videoId);
  }

  _createYTPlayer(videoId) {
    const iframe = document.createElement('iframe');
    iframe.id = 'yt-frame';
    iframe.src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&controls=0&rel=0&playsinline=1&disablekb=1&mute=1`;
    iframe.allow = "autoplay; encrypted-media";
    this.container.appendChild(iframe);

    const readyTimeout = setTimeout(() => {
      if (!this.isReady) {
        this.isReady = true;
        if (this.pendingPlay) { this.play(); this.pendingPlay = false; }
      }
    }, 4000);

    this.instance = new YT.Player('yt-frame', {
      videoId,
      playerVars: {
        controls: 0,
        rel: 0,
        playsinline: 1,
        modestbranding: 1,
        mute: 1,
      },
      events: {
        onReady: () => {
          clearTimeout(readyTimeout);
          this.isReady = true;
          this._pendingYTVideoId = null;
          this.duration = this.instance.getDuration();
          this._updateTimeDisplay();
          hideLoading();
          if (this.pendingPlay) { this.play(); this.pendingPlay = false; }
        },
        onStateChange: (e) => {
          this._handleYTStateChange(e);
        },
        onError: (e) => {
          clearTimeout(readyTimeout);
          this.isReady = true;
          hideLoading();
        },
      },
    });
  }

  _loadNative(url) {
    this.container.innerHTML = '';
    const video = document.createElement('video');
    video.src = url;
    video.playsInline = true;
    video.controls = false;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.muted = true;

    if (url.toLowerCase().endsWith('.m3u8')) {
      if (window.Hls && Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(url);
        hls.attachMedia(video);
        window.hlsInstance = hls;
      }
    }

    this.container.appendChild(video);
    this.instance = video;
    this.type = 'native';
    this.isReady = true;
    this._pendingYTVideoId = null;

    this._bindNativeEvents(video);
  }

  _loadNativeFallback(url) {
    this.destroy();
    this._loadNative(url);
  }

  _bindNativeEvents(video) {
    video.addEventListener('loadedmetadata', () => {
      this.duration = video.duration;
      this._updateTimeDisplay();
      hideLoading();
    });

    video.addEventListener('error', (e) => {
      console.error('[Player] video error:', e);
      hideLoading();
      showSnack('❌ Не удалось загрузить видео');
    });

    video.addEventListener('timeupdate', () => {
      this._updateTimeDisplay();
    });

    video.addEventListener('seeked', () => {
      this._updateTimeDisplay();
    });

    video.addEventListener('ended', () => {
      state.isPlaying = false;
      this._updatePlayButton(false);
      if (!isSyncing) {
        onUserPause();
      }
    });

    video.addEventListener('play', () => {
      if (isSyncing) return;
      if (state.isHost) {
        state.isPlaying = true;
        onUserPlay();
      }
    });

    video.addEventListener('pause', () => {
      if (isSyncing) return;
      if (state.isHost) {
        state.isPlaying = false;
        onUserPause();
      }
    });

    video.addEventListener('seeked', () => {
      if (isSyncing) return;
      if (state.isHost) {
        onUserSeek(video.currentTime);
      }
    });
  }

  play() {
    if (!this.isReady) {
      this.pendingPlay = true;
      return;
    }
    if (this.type === 'yt' && this.instance?.playVideo) {
      this.instance.playVideo();
    } else if (this.type === 'native' && this.instance) {
      const promise = this.instance.play();
      if (promise !== undefined) {
        promise.catch(() => {
          this.instance.muted = true;
          this.instance.play();
        });
      }
    }
    this._updatePlayButton(true);
    state.isPlaying = true;
  }

  pause() {
    if (!this.isReady) return;
    if (this.type === 'yt' && this.instance?.pauseVideo) {
      this.instance.pauseVideo();
    } else if (this.instance) {
      this.instance.pause();
    }
    this._updatePlayButton(false);
    state.isPlaying = false;
  }

  seekTo(seconds) {
    if (!this.isReady) return;
    if (this.type === 'yt' && this.instance?.seekTo) {
      this.instance.seekTo(seconds, true);
    } else if (this.instance) {
      this.instance.currentTime = seconds;
    }
    this._updateProgress(seconds);
    this._updateTimeDisplay();
  }

  setRate(rate) {
    if (!this.isReady) return;
    currentPlaybackRate = rate;
    if (this.type === 'yt' && this.instance?.setPlaybackRate) {
      this.instance.setPlaybackRate(rate);
    } else if (this.instance) {
      this.instance.playbackRate = rate;
    }
  }

  getCurrentTime() {
    if (!this.isReady) return 0;
    if (this.type === 'yt' && this.instance?.getCurrentTime) {
      try { return this.instance.getCurrentTime(); } catch (e) { return 0; }
    } else if (this.instance) {
      return this.instance.currentTime || 0;
    }
    return 0;
  }

  getDuration() {
    if (!this.isReady) return 0;
    if (this.type === 'yt' && this.instance?.getDuration) {
      try { return this.instance.getDuration(); } catch (e) { return this.duration; }
    } else if (this.instance) {
      return this.instance.duration || this.duration;
    }
    return this.duration;
  }

  isPaused() {
    if (!this.isReady) return true;
    if (this.type === 'yt' && this.instance?.getPlayerState) {
      const ps = this.instance.getPlayerState();
      return ps !== YT.PlayerState.PLAYING;
    } else if (this.instance) {
      return this.instance.paused;
    }
    return true;
  }

  isBuffering() {
    if (!this.isReady || this.type !== 'yt' || !this.instance?.getPlayerState) return false;
    const ps = this.instance.getPlayerState();
    return ps === YT.PlayerState.BUFFERING;
  }

  destroy() {
    if (this.instance) {
      if (this.type === 'yt' && typeof this.instance.destroy === 'function') {
        try { this.instance.destroy(); } catch (e) {}
      }
    }
    this.instance = null;
    this.isReady = false;
    this.type = null;
    this.duration = 0;
    this.container.innerHTML = '';
  }

  _handleYTStateChange(e) {
    const YT_STATES = {
      [-1]: 'UNSTARTED',
      0: 'ENDED',
      1: 'PLAYING',
      2: 'PAUSED',
      3: 'BUFFERING',
      5: 'CUED',
    };
    const stateName = YT_STATES[e.data] || e.data;
    console.log('[YouTube] State →', stateName);

    if (isSyncing) return;

    switch (e.data) {
      case YT.PlayerState.PLAYING:
        if (state.isHost) {
          state.isPlaying = true;
          onUserPlay();
        }
        break;
      case YT.PlayerState.ENDED:
        if (state.isHost) {
          state.isPlaying = false;
          onUserPause();
        }
        break;
    }
  }

  _updatePlayButton(playing) {
    if (els.ravePlayBtn) {
      els.ravePlayBtn.textContent = playing ? '⏸' : '▶';
    }
  }

  _updateProgress(seconds) {
    if (els.raveProgressFill) {
      const dur = this.duration || this.getDuration();
      const pct = dur > 0 ? (seconds / dur) * 100 : 0;
      els.raveProgressFill.style.width = `${pct}%`;
    }
  }

  _updateTimeDisplay() {
    if (!els.raveTimeDisplay) return;
    const current = this.getCurrentTime();
    const duration = this.getDuration();
    els.raveTimeDisplay.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  }

  startProgressTracking() {
    if (this._progressTimer) clearInterval(this._progressTimer);
    this._progressTimer = setInterval(() => {
      if (this.isReady && !this.isPaused()) {
        this._updateProgress(this.getCurrentTime());
        this._updateTimeDisplay();
      }
    }, 500);
  }

  stopProgressTracking() {
    if (this._progressTimer) {
      clearInterval(this._progressTimer);
      this._progressTimer = null;
    }
  }
}

window.raveEngine = new RavePlayerEngine('player-render-layer');

// ═══════════════════════════════════════════════════════════
// YouTube IFrame API динамическая загрузка
// ═══════════════════════════════════════════════════════════

function loadYouTubeAPI() {
  if (state.ytApiLoaded || window.YT) {
    state.ytApiLoaded = true;
    // Если плеер уже создан, а API пришло позже — создаём YT-player
    if (window.raveEngine && window.raveEngine._pendingYTVideoId) {
      const id = window.raveEngine._pendingYTVideoId;
      window.raveEngine._createYTPlayer(id);
    }
    return;
  }

  window.onYouTubeIframeAPIReady = function () {
    console.log('[YouTube] IFrame API готов');
    state.ytReady = true;
    state.ytApiLoaded = true;

    if (window.raveEngine && window.raveEngine._pendingYTVideoId) {
      const id = window.raveEngine._pendingYTVideoId;
      window.raveEngine._createYTPlayer(id);
    }
  };

  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.onerror = () => {
    console.error('[YouTube] API не загрузился');
    hideLoading();
  };
  const firstScriptTag = document.getElementsByTagName('script')[0];
  firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
}

// ═══════════════════════════════════════════════════════════
// УТИЛИТЫ / СНИППЕТЫ DOM
// ═══════════════════════════════════════════════════════════

function sanitizeRoom(room) {
  if (typeof room !== 'string') return null;
  const cleaned = room.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned || null;
}

function parseUrl(rawUrl) {
  const url = (rawUrl || '').trim();
  if (!url) return { type: SOURCE_TYPES.UNKNOWN, payload: null };

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { type: SOURCE_TYPES.UNKNOWN, payload: { error: 'Невалидный URL' } };
  }

  const host = parsed.hostname.toLowerCase();

  if (
    host === 'youtube.com' || host === 'www.youtube.com' ||
    host === 'm.youtube.com' || host === 'music.youtube.com' ||
    host === 'youtu.be' || host.endsWith('.youtube.com')
  ) {
    const videoId = extractYouTubeId(url);
    if (videoId && /^[a-zA-Z0-9_-]{6,15}$/.test(videoId)) {
      return { type: SOURCE_TYPES.YOUTUBE, payload: { videoId } };
    }
    return { type: SOURCE_TYPES.UNKNOWN, payload: { error: 'Не удалось распознать YouTube-видео' } };
  }

  const directMediaExt = /\.(mp4|webm|ogg|ogv|mov|m4v)(\?.*)?$/i;
  if (directMediaExt.test(parsed.pathname)) {
    return { type: SOURCE_TYPES.NATIVE, payload: { url } };
  }

  if (parsed.pathname.toLowerCase().endsWith('.m3u8')) {
    return { type: SOURCE_TYPES.HLS, payload: { url } };
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return { type: SOURCE_TYPES.IFRAME, payload: { embedUrl: url, originalUrl: url } };
  }

  return { type: SOURCE_TYPES.UNKNOWN, payload: null };
}

function extractYouTubeId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'youtu.be') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      return parts[0] || null;
    }
    const v = parsed.searchParams.get('v');
    if (v) return v;
    const m = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/);
    if (m) return m[1];
  } catch (e) {}
  return null;
}

function formatTitle(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace('www.', '');
    if (parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be')) {
      return 'YouTube — ' + (parsed.searchParams.get('v') || 'видео');
    }
    if (parsed.pathname.endsWith('.m3u8')) return 'HLS-поток — ' + host;
    const filename = parsed.pathname.split('/').filter(Boolean).pop();
    if (filename) return filename + ' — ' + host;
    return host;
  } catch (e) {
    return url;
  }
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return String(str).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

function showSnack(text, ms = 2500) {
  if (!snackbarEl) {
    snackbarEl = document.createElement('div');
    snackbarEl.className = 'snackbar';
    document.body.appendChild(snackbarEl);
  }

  snackbarEl.textContent = text;
  snackbarEl.classList.add('show');

  clearTimeout(snackbarTimer);
  snackbarTimer = setTimeout(() => {
    snackbarEl.classList.remove('show');
  }, ms);
}

function setStatus(text) {
  console.log('[Status]', text);
  if (els.diagStatus) els.diagStatus.textContent = text;
}

function updateDiagnostic(data) {
  if (els.diagRoomState) els.diagRoomState.textContent = data.roomState || '—';
  if (els.diagUrl) els.diagUrl.textContent = data.url || '—';
  if (els.diagType) els.diagType.textContent = data.type || '—';
}

function updateConnUI(connected) {
  els.connStatus.classList.toggle('connected', connected);
  els.connStatus.classList.toggle('disconnected', !connected);
  els.connText.textContent = connected ? 'В сети' : 'Нет соединения';
}

function showLoading(text) {
  if (els.loadingOverlay) {
    if (text && els.loadingText) els.loadingText.textContent = text;
    els.loadingOverlay.classList.remove('hidden');
  }
}

function hideLoading() {
  if (els.loadingOverlay) {
    els.loadingOverlay.classList.add('hidden');
  }
}

function showPlaceholder() {
  const layer = els.playerRenderLayer;
  if (!layer) return;
  layer.innerHTML = `
    <div class="player-placeholder" style="color: var(--tg-text);">
      <div class="placeholder-icon" style="font-size: 48px; margin-bottom: 12px; opacity: 0.7;">🎥</div>
      <div class="placeholder-title" style="font-size: 18px; font-weight: 700; margin-bottom: 8px;">Начнём смотреть вместе?</div>
      <div class="placeholder-sub" style="font-size: 13px; line-height: 1.5; color: var(--tg-hint);">
        Нажмите «Сменить видео» и вставьте ссылку.<br>
        Всё, что вы запускаете, синхронно увидит ваш собеседник.
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════
// ИНИЦИАЛИЗАЦИЯ TELEGRAM WEBAPP SDK
// ═══════════════════════════════════════════════════════════

function initTelegram() {
  if (!window.Telegram || !window.Telegram.WebApp) {
    console.warn('Telegram WebApp SDK недоступен — работаем в обычном браузере.');
    return;
  }

  const tg = window.Telegram.WebApp;
  tg.expand();
  tg.ready();

  try {
    tg.setHeaderColor(tg.themeParams.bg_color || '#17212b');
    tg.setBackgroundColor(tg.themeParams.bg_color || '#17212b');
  } catch (e) {}

  const initData = tg.initDataUnsafe || {};
  const user = initData.user || {};

  if (user.first_name || user.username) {
    state.userName = user.first_name || user.username || 'Гость';
    state.userId = user.id != null ? String(user.id) : null;
  }

  let roomFromTelegram =
    initData.start_param ||
    new URLSearchParams(window.location.search).get('room') ||
    '';

  if (roomFromTelegram && /^[a-zA-Z0-9_-]{1,64}$/.test(roomFromTelegram)) {
    state.roomId = roomFromTelegram;
    window.currentRoomId = roomFromTelegram;
  }

  console.log('[Telegram] initData →', {
    room: state.roomId,
    user: state.userName,
  });

  const setPlayerHeight = () => {
    document.documentElement.style.setProperty('--player-h', '240px');
  };
  setPlayerHeight();

  tg.onEvent('viewportChanged', () => setPlayerHeight());
}

function generateRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'r_';
  try {
    const arr = new Uint32Array(6);
    crypto.getRandomValues(arr);
    for (let i = 0; i < arr.length; i++) {
      result += chars[arr[i] % chars.length];
    }
  } catch (e) {
    result += Math.random().toString(36).slice(2, 10);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════
// 4. ЗАГРУЗКА МЕДИА
// ═══════════════════════════════════════════════════════════

function loadMedia(rawUrl, opts = {}) {
  const { autoplay = true } = opts;
  const parsed = parseUrl(rawUrl);

  if (parsed.type === SOURCE_TYPES.UNKNOWN || !parsed.payload) {
    const errMsg = parsed.payload?.error || 'Не удалось распознать ссылку';
    console.error('[LoadMedia] Ошибка:', errMsg);
    setStatus('⚠️ ' + errMsg);
    showSnack('❌ ' + errMsg);
    hideLoading();
    return false;
  }

  const trimmedUrl = rawUrl.trim();
  state.currentType = parsed.type;

  showLoading('Загрузка видео…');

  raveEngine.destroy();

  if (!state.ytApiLoaded && parsed.type === SOURCE_TYPES.YOUTUBE) {
    loadYouTubeAPI();
    // Fallback: если API не загрузится за 8 секунд — используем iframe
    setTimeout(() => {
      if (!state.ytApiLoaded && raveEngine.type === 'yt' && !raveEngine.isReady) {
        console.warn('[YouTube] API не загрузился за 8с — iframe fallback');
        hideLoading();
        raveEngine._loadNativeFallback(`https://www.youtube.com/watch?v=${parsed.payload.videoId}`);
      }
    }, 8000);
  }

  raveEngine.load(parsed.type === SOURCE_TYPES.YOUTUBE
    ? `https://www.youtube.com/watch?v=${parsed.payload.videoId}`
    : trimmedUrl);

  raveEngine.startProgressTracking();

  if (autoplay && state.isHost) {
    setTimeout(() => {
      if (!raveEngine.isReady) return;
      if (raveEngine.isPaused()) {
        isSyncing = true;
        raveEngine.play();
        onUserPlay();
      }
    }, 500);
  }

  state.currentUrl = trimmedUrl;
  if (els.nowPlayingTitle) {
    els.nowPlayingTitle.textContent = formatTitle(state.currentUrl);
  }

  if (state.isHost && !isSyncing) {
    if (state.socket && state.connected && window.currentRoomId) {
      state.socket.emit('CHANGE_MEDIA', {
        mediaType: parsed.type,
        url: state.currentUrl,
        time: 0,
      });
    }
  }

  return true;
}

// ═══════════════════════════════════════════════════════════
// 5. SOCKET.IO
// ═══════════════════════════════════════════════════════════

function connectSocket() {
  const socketUrl = window.location.origin;
  const query = state.roomId ? { room: state.roomId } : {};

  state.socket = io(socketUrl, {
    transports: ['websocket', 'polling'],
    query,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  const s = state.socket;

  s.on('connect', () => {
    state.connected = true;
    updateConnUI(true);
    console.log('[Socket] Подключено →', socketUrl, '| room:', state.roomId || '(лобби)');
    startClockSync();
    if (state.roomId) {
      window.currentRoomId = state.roomId;
      s.emit('join-room', { roomId: state.roomId });
    }
  });

  s.on('disconnect', (reason) => {
    state.connected = false;
    updateConnUI(false);
    console.warn('[Socket] Отключено:', reason);
    stopClockSync();
  });

  s.on('connect_error', (err) => {
    console.error('[Socket] Ошибка подключения:', err.message);
  });

  s.on('hello', (data) => {
    console.log('[Socket] hello →', data);
    state.isHost = !!data.isHost;
    updateHostUI();
  });

  s.on('init-room-state', (data) => {
    console.log('[Socket] init-room-state ←', data);

    const roomUrl = data.currentUrl;
    const roomTime = getServerAuthoritativePosition(data);
    const roomPlaying = !!data.isPlaying;

    if (roomUrl) {
      const parsed = parseUrl(roomUrl);
      if (parsed.type !== SOURCE_TYPES.UNKNOWN) {
        state.currentType = parsed.type;
      }
    } else if (data.currentType) {
      state.currentType = data.currentType;
    }

    updateDiagnostic({
      roomState: 'получено',
      url: roomUrl || '—',
      type: state.currentType,
    });

    if (typeof data.viewers === 'number') {
      state.viewers = data.viewers;
      updatePeersCount();
      renderDrawerPeers();
    }

    if (roomUrl) {
      if (roomUrl !== state.currentUrl) {
        showLoading('Загрузка видео…');
        isSyncing = true;
        const ytId = extractYouTubeId(roomUrl);
        if (ytId) {
          loadYouTubeAPI();
        }
        raveEngine.destroy();
        raveEngine.load(roomUrl);
        raveEngine.startProgressTracking();

        setTimeout(() => {
          if (!raveEngine.isReady) return;
          isSyncing = true;
          raveEngine.seekTo(roomTime);
          if (roomPlaying) {
            raveEngine.play();
          }
          setTimeout(() => { isSyncing = false; }, 400);
        }, 800);
      } else {
        if (roomPlaying && raveEngine.isPaused()) {
          isSyncing = true;
          raveEngine.seekTo(roomTime);
          raveEngine.play();
          setTimeout(() => { isSyncing = false; }, 400);
        } else if (!roomPlaying && !raveEngine.isPaused()) {
          isSyncing = true;
          raveEngine.seekTo(roomTime);
          raveEngine.pause();
          setTimeout(() => { isSyncing = false; }, 400);
        }
      }
    } else if (state.currentUrl) {
      raveEngine.destroy();
      showPlaceholder();
      state.currentUrl = '';
    }

    if (els.nowPlayingTitle) {
      els.nowPlayingTitle.textContent = roomUrl ? formatTitle(roomUrl) : '—';
    }

    if (Array.isArray(data.queue)) {
      state.queue = data.queue;
      renderQueue();
    }
  });

  // Rave: Server-side Master Clock + Dynamic Playback Rate
  s.on('sync-state', ({ serverTime, isPlaying, serverTimestamp, currentUrl, currentType }) => {
    if (state.isHost) return; // Хост — источник истины

    // Если пришел новый URL — загружаем видео
    if (currentUrl && currentUrl !== state.currentUrl) {
      state.currentUrl = currentUrl;
      state.currentType = currentType || state.currentType;

      if (els.nowPlayingTitle) {
        els.nowPlayingTitle.textContent = formatTitle(currentUrl);
      }

      showLoading('Загрузка видео…');

      if (currentType === 'youtube' || extractYouTubeId(currentUrl)) {
        loadYouTubeAPI();
      }

      isSyncing = true;
      raveEngine.destroy();
      raveEngine.load(currentUrl);
      raveEngine.startProgressTracking();

      setTimeout(() => {
        if (!raveEngine.isReady) return;
        isSyncing = true;
        const targetTime = serverTime + (Date.now() - serverTimestamp) / 2000;
        raveEngine.seekTo(targetTime);
        if (isPlaying && !raveEngine.isBuffering()) {
          raveEngine.play();
        }
        setTimeout(() => { isSyncing = false; }, 400);
      }, 800);

      return;
    }

    const player = raveEngine;
    if (!player || !player.isReady) return;

    // А. Ping Compensation
    const latency = (Date.now() - serverTimestamp) / 2000;
    const targetTime = serverTime + latency;
    const localTime = player.getCurrentTime();
    const diff = targetTime - localTime;

    isSyncing = true; // Блокируем отправку локальных событий

    // Б. Состояние Play / Pause — только при реальном рассинхроне
    const playerPaused = player.isPaused();

    if (isPlaying && playerPaused && !player.isBuffering()) {
      player.play();
      player.setRate(currentPlaybackRate);
      setTimeout(() => { isSyncing = false; }, 400);
      return;
    } else if (!isPlaying && !playerPaused) {
      player.pause();
      player.setRate(1.0);
      currentPlaybackRate = 1.0;
      setTimeout(() => { isSyncing = false; }, 300);
      return;
    }

    if (!isPlaying && playerPaused) {
      if (Math.abs(diff) > 2.5) {
        player.seekTo(targetTime);
      }
      setTimeout(() => { isSyncing = false; }, 400);
      return;
    }

    // В. Логика Rave: дифференциальная подстройка скорости
    const absDiff = Math.abs(diff);

    if (absDiff > 2.5) {
      player.seekTo(targetTime);
      player.setRate(1.0);
      currentPlaybackRate = 1.0;
    } else if (diff > 0.3) {
      if (currentPlaybackRate !== 1.05) {
        player.setRate(1.05);
        currentPlaybackRate = 1.05;
      }
    } else if (diff < -0.3) {
      if (currentPlaybackRate !== 0.95) {
        player.setRate(0.95);
        currentPlaybackRate = 0.95;
      }
    } else {
      if (currentPlaybackRate !== 1.0) {
        player.setRate(1.0);
        currentPlaybackRate = 1.0;
      }
    }

    setTimeout(() => { isSyncing = false; }, 400);
  });

  s.on('rooms-updated', (rooms) => {
    renderRoomsList(rooms);
  });

  s.on('QUEUE_UPDATED', ({ queue }) => {
    state.queue = Array.isArray(queue) ? queue : [];
    renderQueue();
  });

  s.on('ERROR', ({ message }) => {
    showSnack('⚠️ ' + message);
  });

  s.on('USER_LEFT', ({ id, viewers }) => {
    state.peers = state.peers.filter((p) => p.id !== id);
    if (typeof viewers === 'number') {
      state.viewers = viewers;
    }
    updatePeersCount();
    renderDrawerPeers();
    showSnack('👋 Участник покинул комнату');
  });

  s.on('USER_JOINED', ({ id, isHost, viewers }) => {
    if (typeof viewers === 'number') {
      state.viewers = viewers;
      updatePeersCount();
      renderDrawerPeers();
    }
    showSnack('👤 Новый участник в комнате');
  });

  s.on('HOST_CHANGED', ({ hostId }) => {
    state.isHost = hostId === state.socket.id;
    updateHostUI();
    showSnack(state.isHost ? '👑 Вы теперь хост' : '👑 Хост сменился');
  });

  s.on('CHAT', (data) => {
    addChatMessage(data, data.socketId === state.socket?.id);
  });

  s.on('CHAT_HISTORY', ({ messages }) => {
    if (Array.isArray(messages)) {
      state.messages = [];
      els.chatMessages.innerHTML = '';
      checkChatEmpty();
      messages.forEach((msg) => addChatMessage(msg, msg.socketId === state.socket?.id));
    }
  });

  s.on('message-reaction-updated', ({ messageId, emoji, userId, reactions }) => {
    state.reactions[messageId] = reactions || {};
    renderMessageReactions(messageId);
  });

  s.on('ALL_REACTIONS', ({ reactions }) => {
    if (reactions && typeof reactions === 'object') {
      state.reactions = reactions;
      Object.keys(reactions).forEach((messageId) => renderMessageReactions(messageId));
    }
  });
}

// ═══════════════════════════════════════════════════════════
// Rave: Отправка действий пользователя (с защитой от петли)
// ═══════════════════════════════════════════════════════════

let lastPlayTimestamp = 0;

function onUserPlay() {
  if (isSyncing || !state.isHost) return;
  lastPlayTimestamp = Date.now();
  const time = raveEngine.getCurrentTime();
  state.socket.emit('player-action', {
    roomId: window.currentRoomId,
    action: 'play',
    time,
  });
}

function onUserPause() {
  if (isSyncing || !state.isHost) return;
  // Защита от спурлиусных пауз YouTube (autopause при потере фокуса / buffering):
  // если играли меньше 1.5 секунд назад — не посылаем pause
  if (Date.now() - lastPlayTimestamp < 1500) return;
  const time = raveEngine.getCurrentTime();
  state.socket.emit('player-action', {
    roomId: window.currentRoomId,
    action: 'pause',
    time,
  });
}

function onUserSeek(newTime) {
  if (isSyncing || !state.isHost) return;
  state.socket.emit('player-action', {
    roomId: window.currentRoomId,
    action: 'seek',
    time: newTime,
  });
}

// ═══════════════════════════════════════════════════════════
// Server-authoritative позиция
// ═══════════════════════════════════════════════════════════

function getServerNowMs() {
  return Date.now() + state.serverTimeOffsetMs;
}

function getServerAuthoritativePosition(data) {
  if (data.isPlaying && typeof data.anchorTimestamp === 'number') {
    const anchorTime = typeof data.anchorTime === 'number' ? data.anchorTime : 0;
    const elapsed = (getServerNowMs() - data.anchorTimestamp) / 1000;
    return Math.max(0, anchorTime + elapsed);
  }
  return typeof data.anchorTime === 'number' ? data.anchorTime : 0;
}

// ═══════════════════════════════════════════════════════════
// Часы (ping/pong)
// ═══════════════════════════════════════════════════════════

function sendPing() {
  if (!state.socket || !state.connected) return;
  state.socket.emit('PING', { clientTime: Date.now() });
}

function startClockSync() {
  stopClockSync();
  sendPing();
  state.clockSyncInterval = setInterval(sendPing, 15000);
}

function stopClockSync() {
  if (state.clockSyncInterval) {
    clearInterval(state.clockSyncInterval);
    state.clockSyncInterval = null;
  }
}

function handlePong(data) {
  const now = Date.now();
  const clientTime = Number(data?.clientTime || now);
  const rtt = now - clientTime;
  const serverTime = Number(data?.serverTime || now);
  const offset = serverTime - (clientTime + rtt / 2);
  state.serverTimeOffsetMs = offset;
  state.serverPingMs = rtt;
  console.log('[Sync] PONG offset=', offset, 'rtt=', rtt);
}

// ═══════════════════════════════════════════════════════════
// window.raveApp — публичный API для inline onclick в index.html
// ═══════════════════════════════════════════════════════════

window.raveApp = {
  togglePlayPause() {
    if (raveEngine.type === 'native' && raveEngine.instance) {
      raveEngine.instance.muted = false;
    }
    if (raveEngine.type === 'yt' && raveEngine.instance?.unMute) {
      raveEngine.instance.unMute();
    }

    if (!raveEngine.isReady) return;
    if (!state.isHost || isSyncing) return;

    if (raveEngine.isPaused() && !raveEngine.isBuffering()) {
      isSyncing = true;
      raveEngine.play();
      onUserPlay();
    } else {
      isSyncing = true;
      raveEngine.pause();
      onUserPause();
    }
  },

  handleSeek(event) {
    if (!raveEngine.isReady || !state.isHost || isSyncing) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const pos = (event.clientX - rect.left) / rect.width;
    const duration = raveEngine.getDuration();
    if (!duration || duration <= 0) return;

    const targetTime = pos * duration;
    isSyncing = true;
    raveEngine.seekTo(targetTime);
    onUserSeek(targetTime);
  },

  play() {
    if (!state.isHost || isSyncing) return;
    isSyncing = true;
    raveEngine.play();
    onUserPlay();
  },

  pause() {
    if (!state.isHost || isSyncing) return;
    isSyncing = true;
    raveEngine.pause();
    onUserPause();
  },

  seekTo(seconds) {
    if (!state.isHost || isSyncing) return;
    isSyncing = true;
    raveEngine.seekTo(seconds);
    onUserSeek(seconds);
  },
};

// ═══════════════════════════════════════════════════════════
// UI-ХЕЛПЕРЫ
// ═══════════════════════════════════════════════════════════

function updatePeersCount() {
  if (els.peersCount) {
    els.peersCount.textContent = Math.max(1, state.viewers);
  }
}

function updateHostUI() {
  if (els.changeMediaBtn) {
    els.changeMediaBtn.style.display = state.isHost ? '' : 'none';
  }

  const hostLabel = document.getElementById('hostLabel');
  if (hostLabel) {
    hostLabel.textContent = state.isHost ? '👑 Вы хост' : '👤 Вы гость';
  }

  // Показать/скрыть кастомные контролы плеера только для хоста
  const controls = $('#rave-controls-bar');
  if (controls) {
    controls.style.display = state.isHost ? 'flex' : 'none';
  }
}

function joinRoom(roomId) {
  if (!roomId) return;
  window.currentRoomId = roomId;
  state.roomId = roomId;
  if (state.socket && state.connected) {
    state.socket.emit('join-room', { roomId });
  }
  showRoomView();
}

function showRoomView() {
  if (els.roomViewScreen) {
    els.roomViewScreen.classList.remove('hidden');
    els.roomViewScreen.style.display = 'flex';
  }
  const nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = 'none';
  hideLoading();
}

function hideRoomView() {
  if (els.roomViewScreen) {
    els.roomViewScreen.classList.add('hidden');
    els.roomViewScreen.style.display = 'none';
  }
  const nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = 'flex';
}

function setActiveTab(tabId) {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.tab === tabId);
  });
}

function loadVideoIntoPlayer(url) {
  if (!url) return;

  showRoomView();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      loadMedia(url);
    });
  });
}

function joinRoomByCode() {
  const code = els.joinCodeInput.value.trim();
  if (!code) {
    showSnack('🔑 Введите код комнаты');
    return;
  }

  let roomId = code;
  if (!roomId.startsWith('r_')) {
    roomId = 'r_' + roomId;
  }

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(roomId)) {
    showSnack('❌ Некорректный код комнаты');
    return;
  }

  state.roomId = roomId;
  window.currentRoomId = roomId;
  els.roomBadge.textContent = state.roomId;
  els.roomBadge.title = 'Комната: ' + state.roomId;
  if (els.myRoomCode) els.myRoomCode.textContent = state.roomId;

  if (state.socket) {
    state.socket.emit('leave-room');
    state.socket.disconnect();
    state.socket = null;
  }
  connectSocket();

  setActiveTab('rooms-tab');
  showRoomView();
  showSnack('🔑 Подключено к комнате: ' + roomId);
  closeDrawer();
}

function openDrawer() {
  els.mediaDrawer.classList.add('open');
  els.drawerOverlay.classList.remove('hidden');
  setTimeout(() => els.urlInput.focus(), 300);
}

function closeDrawer() {
  els.mediaDrawer.classList.remove('open');
  els.drawerOverlay.classList.add('hidden');
}

function inviteFriend() {
  const inviteUrl = makeInviteUrl();

  try {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(inviteUrl);
    } else {
      Telegram.WebApp.Clipboard?.writeText(inviteUrl);
    }
    showSnack('🔗 Ссылка-приглашение скопирована');
  } catch (e) {
    els.urlInput.value = inviteUrl;
    openDrawer();
    showSnack('🔗 Ссылка скопирована в поле ввода');
  }
}

function makeInviteUrl() {
  const base = window.location.origin + window.location.pathname;
  const room = encodeURIComponent(state.roomId);
  return `${base}?room=${room}`;
}

function renderQueue() {
  const queueList = document.getElementById('queueList');
  if (!queueList) return;

  if (state.queue.length === 0) {
    queueList.innerHTML = '<div class="queue-empty">Очередь пуста</div>';
    return;
  }

  queueList.innerHTML = state.queue.map((item, i) => `
    <div class="queue-item">
      <span class="queue-icon">🎬</span>
      <span class="queue-name">${escapeHtml(formatTitle(item.url))}</span>
      ${state.isHost ? `<button class="queue-remove" data-index="${i}" type="button">✕</button>` : ''}
    </div>
  `).join('');
}

function renderDrawerPeers() {
  if (!els.drawerPeers) return;

  const peersHtml = [
    `<div class="drawer-peer">🎬 Вы (${escapeHtml(state.userName)})</div>`,
    ...state.peers.map((p) => (
      `<div class="drawer-peer">👤 ${escapeHtml(p.name)}</div>`
    )),
  ].join('');

  els.drawerPeers.innerHTML = peersHtml;
}

function renderRoomsList(rooms) {
  const container = document.getElementById('roomList');
  if (!container) return;

  if (!rooms || rooms.length === 0) {
    container.innerHTML = '<div class="room-empty">Нет доступных комнат</div>';
    return;
  }

  container.innerHTML = rooms.map(room => `
    <div class="room-item" data-room="${escapeHtml(room.id)}">
      <span class="room-item-icon">🎬</span>
      <div class="room-item-info">
        <span class="room-item-name">${escapeHtml(room.name || room.id)}</span>
        <span class="room-item-sub">Участников: ${room.usersCount || 1}</span>
      </div>
      <button class="btn btn-primary btn-sm room-join" data-room="${escapeHtml(room.id)}" type="button">Войти</button>
    </div>
  `).join('');

  container.querySelectorAll('.room-join').forEach((btn) => {
    btn.addEventListener('click', () => {
      const roomId = btn.dataset.room;
      if (!roomId) return;
      state.roomId = roomId;
      window.currentRoomId = roomId;
      els.roomBadge.textContent = state.roomId;
      els.roomBadge.title = 'Комната: ' + state.roomId;
      if (els.myRoomCode) els.myRoomCode.textContent = state.roomId;

      if (state.socket) {
        state.socket.emit('leave-room');
        state.socket.disconnect();
        state.socket = null;
      }
      connectSocket();

      setActiveTab('rooms-tab');
      showRoomView();
      showSnack('🔑 Вошли в комнату: ' + roomId);
    });
  });
}

// ═══════════════════════════════════════════════════════════
// ЧАТ
// ═══════════════════════════════════════════════════════════

function checkChatEmpty() {
  if (els.chatEmpty) {
    els.chatEmpty.classList.toggle('hidden', state.messages.length > 0);
  }
}

function addChatMessage(msg, mine = false) {
  if (!msg || !msg.text) return;

  if (msg.id && state.messages.some(m => m.id === msg.id)) return;

  state.messages.push(msg);
  checkChatEmpty();

  const el = document.createElement('div');
  el.className = 'message-bubble ' + (mine ? 'outgoing' : 'incoming');
  el.dataset.messageId = msg.id || '';

  const time = formatTime(msg.time);
  const sender = escapeHtml(msg.sender || 'Гость');

  let replyHtml = '';
  if (msg.replyToId && msg.replyToText) {
    replyHtml = `
      <div class="reply-quote">
        <span class="reply-author">${escapeHtml(msg.replyToSender || 'Гость')}</span>
        <span class="reply-text">${escapeHtml(msg.replyToText.slice(0, 50))}</span>
      </div>
    `;
  }

  let reactionsHtml = '';
  if (msg.id && state.reactions[msg.id] && Object.keys(state.reactions[msg.id]).length > 0) {
    reactionsHtml = '<div class="message-reactions-container">';
    for (const [emoji, users] of Object.entries(state.reactions[msg.id])) {
      if (users.length > 0) {
        reactionsHtml += `<span class="reaction-item">${emoji} <span class="reaction-count">${users.length}</span></span>`;
      }
    }
    reactionsHtml += '</div>';
  }

  el.innerHTML = `
    <span class="message-sender">${mine ? 'Вы' : sender}</span>
    ${replyHtml}
    <span class="message-text">${escapeHtml(msg.text)}</span>
    <span class="message-time">${time}</span>
    ${reactionsHtml}
  `;

  els.chatMessages.appendChild(el);
  scrollChatToBottom();
}

function cancelReply() {
  state.replyTo = null;
  const replyPreview = document.getElementById('reply-preview');
  if (replyPreview) replyPreview.style.display = 'none';
}

function renderMessageReactions(messageId) {
  const msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!msgEl) return;

  const existing = msgEl.querySelector('.message-reactions-container');
  if (existing) existing.remove();

  if (state.reactions[messageId] && Object.keys(state.reactions[messageId]).length > 0) {
    const container = document.createElement('div');
    container.className = 'message-reactions-container';
    for (const [emoji, users] of Object.entries(state.reactions[messageId])) {
      if (users.length > 0) {
        container.innerHTML += `<span class="reaction-item">${emoji} <span class="reaction-count">${users.length}</span></span>`;
      }
    }
    const timeEl = msgEl.querySelector('.message-time');
    if (timeEl) timeEl.insertAdjacentElement('afterend', container);
  }
}

function sendReaction(messageId, emoji) {
  if (!state.socket || !state.connected) {
    showSnack('⚠️ Нет соединения с сервером');
    return;
  }

  state.recentReactions = state.recentReactions.filter(r => r !== emoji);
  state.recentReactions.unshift(emoji);
  state.recentReactions = state.recentReactions.slice(0, 8);
  localStorage.setItem('recent_reactions', JSON.stringify(state.recentReactions));

  state.socket.emit('send-message-reaction', {
    messageId,
    emoji,
    sender: state.userName,
  });

  if (!state.reactions[messageId]) state.reactions[messageId] = {};
  if (!state.reactions[messageId][emoji]) state.reactions[messageId][emoji] = [];
  if (!state.reactions[messageId][emoji].includes(state.socket.id)) {
    state.reactions[messageId][emoji].push(state.socket.id);
  }
  renderMessageReactions(messageId);
}

function sendMessage() {
  const input = els.chatInput;
  if (!input) return;

  const text = input.value.trim();
  if (!text || !window.currentRoomId) return;

  const payload = {
    roomId: window.currentRoomId,
    text,
    sender: state.userName,
  };

  if (state.replyTo) {
    payload.replyToId = state.replyTo.id;
    payload.replyToText = state.replyTo.text;
    payload.replyToSender = state.replyTo.sender;
    cancelReply();
  }

  state.socket.emit('send-message', payload);
  input.value = '';
  input.focus();
}

function scrollChatToBottom() {
  requestAnimationFrame(() => {
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  });
}

// ═══════════════════════════════════════════════════════════
// Романтичные сердечки
// ═══════════════════════════════════════════════════════════

let heartsEnabled = true;

function createHeart() {
  const container = document.querySelector('.hearts-bg');
  if (!container) return;

  const toggle = document.getElementById('heartsToggle');
  if (toggle && !toggle.checked) return;

  if (Math.random() > 0.4) return;

  const count = Math.floor(Math.random() * 3) + 2;

  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const heart = document.createElement('div');
      heart.classList.add('heart-particle');
      const hearts = ['💖', '💕', '💗', '❤️', '🌸'];
      heart.innerText = hearts[Math.floor(Math.random() * hearts.length)];
      heart.style.left = Math.random() * 90 + 5 + '%';
      heart.style.animationDuration = (Math.random() * 3 + 6) + 's';
      heart.style.fontSize = (Math.random() * 8 + 12) + 'px';
      container.appendChild(heart);
      setTimeout(() => { heart.remove(); }, 9000);
    }, i * 200);
  }
}

setInterval(createHeart, 2500);

// ═══════════════════════════════════════════════════════════
// UI привязка
// ═══════════════════════════════════════════════════════════

function bindUI() {
  // Вход по ID комнаты
  const joinRoomBtn = document.getElementById('join-room-btn');
  const joinRoomInput = document.getElementById('join-room-input');
  if (joinRoomBtn && joinRoomInput) {
    joinRoomBtn.addEventListener('click', () => {
      let inputVal = joinRoomInput.value.trim();
      if (!inputVal) return;
      if (inputVal.includes('startapp=')) {
        inputVal = inputVal.split('startapp=')[1];
      }
      state.roomId = inputVal;
      window.currentRoomId = inputVal;
      els.roomBadge.textContent = state.roomId;
      els.roomBadge.title = 'Комната: ' + state.roomId;
      if (els.myRoomCode) els.myRoomCode.textContent = state.roomId;

      if (state.socket) {
        state.socket.emit('leave-room');
        state.socket.disconnect();
        state.socket = null;
      }
      connectSocket();
      setActiveTab('rooms-tab');
      showRoomView();
      showSnack('🔑 Подключено к комнате: ' + inputVal);
    });
  }

  const refreshRoomsBtn = document.getElementById('refreshRoomsBtn');
  if (refreshRoomsBtn) {
    refreshRoomsBtn.addEventListener('click', () => {
      if (state.socket && state.connected) {
        state.socket.emit('get-rooms');
      }
    });
  }

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      const tabId = item.dataset.tab;
      if (!tabId) return;

      hideRoomView();

      document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
      item.classList.add('active');

      document.querySelectorAll('.tab-content').forEach((tab) => {
        tab.style.display = tab.id === tabId ? 'flex' : 'none';
      });

      if (tabId === 'rooms-tab' && state.socket && state.connected) {
        state.socket.emit('get-rooms');
      }

      if (window.Telegram?.WebApp?.HapticFeedback) {
        window.Telegram.WebApp.HapticFeedback.selectionChanged();
      }
    });
  });

  const createRoomBtn = document.getElementById('createRoomBtn');
  if (createRoomBtn) {
    createRoomBtn.addEventListener('click', () => {
      const url = (document.getElementById('createRoomUrl')?.value || '').trim();

      const ensureSocket = () => {
        if (state.socket && state.connected) {
          state.socket.emit('create-room', { name: 'НАША СПАЛЬНЯ 😉' }, handleCreated);
        } else {
          connectSocket();
          setTimeout(ensureSocket, 500);
        }
      };

      const handleCreated = (res) => {
        if (!res || !res.roomId) {
          showSnack('❌ Не удалось создать комнату');
          return;
        }
        state.roomId = res.roomId;
        window.currentRoomId = res.roomId;
        els.roomBadge.textContent = state.roomId;
        els.roomBadge.title = 'Комната: ' + state.roomId;
        if (els.myRoomCode) els.myRoomCode.textContent = state.roomId;

        showRoomView();
        setActiveTab('rooms-tab');
        showSnack('🚀 Комната создана: ' + res.roomId);

        if (state.socket && state.connected) {
          state.socket.emit('get-rooms');
        }

        if (url) {
          loadVideoIntoPlayer(url);
        }
      };

      ensureSocket();
    });
  }

  document.querySelectorAll('.room-join').forEach((btn) => {
    btn.addEventListener('click', () => {
      const roomId = btn.dataset.room;
      if (!roomId) return;
      state.roomId = roomId;
      window.currentRoomId = roomId;
      els.roomBadge.textContent = state.roomId;
      els.roomBadge.title = 'Комната: ' + state.roomId;
      if (els.myRoomCode) els.myRoomCode.textContent = state.roomId;

      if (state.socket) {
        state.socket.emit('leave-room');
        state.socket.disconnect();
        state.socket = null;
      }
      connectSocket();

      setActiveTab('rooms-tab');
      showRoomView();
      showSnack('🔑 Вошли в комнату: ' + roomId);
    });
  });

  els.changeMediaBtn.addEventListener('click', openDrawer);
  els.drawerCloseBtn.addEventListener('click', closeDrawer);
  els.drawerOverlay.addEventListener('click', closeDrawer);

  const cancelReplyBtn = document.getElementById('cancel-reply');
  if (cancelReplyBtn) {
    cancelReplyBtn.addEventListener('click', cancelReply);
  }

  els.joinCodeBtn.addEventListener('click', joinRoomByCode);
  els.joinCodeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      joinRoomByCode();
    }
  });

  els.loadBtn.addEventListener('click', () => {
    const url = els.urlInput.value.trim();
    if (!url) {
      showSnack('🔗 Вставьте ссылку на видео');
      els.urlInput.focus();
      return;
    }
    loadMedia(url);
  });

  els.urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      els.loadBtn.click();
    }
  });

  els.presetRow.addEventListener('click', (event) => {
    const btn = event.target.closest('.preset-btn');
    if (!btn) return;
    const url = btn.dataset.url;
    if (url) loadMedia(url);
  });

  els.inviteBtn.addEventListener('click', inviteFriend);

  els.peersBtn.addEventListener('click', () => {
    state.socket.emit('GET_PEERS');
    openDrawer();
  });

  const queueList = document.getElementById('queueList');
  if (queueList) {
    queueList.addEventListener('click', (event) => {
      const btn = event.target.closest('.queue-remove');
      if (!btn) return;
      const index = Number(btn.dataset.index);
      if (Number.isInteger(index)) {
        state.socket.emit('REMOVE_FROM_QUEUE', { index });
      }
    });
  }

  els.chatSendBtn.addEventListener('click', sendMessage);
  els.chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
}

// ═══════════════════════════════════════════════════════════
// ИНИЦИАЛИЗАЦИЯ
// ═══════════════════════════════════════════════════════════

(function init() {
  console.log('%c RAVE TMA — синхронный просмотр в стиле Rave ', 'background:#5288c1;color:#fff;font-size:14px;padding:6px;border-radius:4px');

  initTelegram();
  bindUI();
  connectSocket();
  showPlaceholder();

  if (els.roomBadge) els.roomBadge.textContent = state.roomId;
  if (els.roomBadge) els.roomBadge.title = 'Комната: ' + state.roomId;
  if (els.myRoomCode) els.myRoomCode.textContent = state.roomId;

  const startParam = (window.Telegram?.WebApp?.initDataUnsafe || {}).start_param;
  if (startParam) {
    setTimeout(() => {
      state.roomId = startParam;
      window.currentRoomId = startParam;
      if (els.roomBadge) els.roomBadge.textContent = state.roomId;
      if (els.roomBadge) els.roomBadge.title = 'Комната: ' + state.roomId;
      if (els.myRoomCode) els.myRoomCode.textContent = state.roomId;
      connectSocket();
      showRoomView();
    }, 500);
  }

  renderDrawerPeers();
  updatePeersCount();

  const mediaParam = new URLSearchParams(window.location.search).get('media');
  if (mediaParam) {
    setTimeout(() => loadMedia(mediaParam), 500);
  }
})();