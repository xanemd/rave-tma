/**
 * ─────────────────────────────────────────────────────────────
 *  RAVE TMA — клиентская логика
 *
 *  Интерфейс в стиле Rave:
 *  - Плеер сверху
 *  - Чат снизу
 *  - Боковая панель для смены видео
 *
 *  Всё синхронное поведение строится на следующих правилах:
 *  1. Каждый клиент общается с сервером через Socket.io.
 *  2. События от ЛОКАЛЬНЫХ действий пользователя
 *     (play / pause / seek / смена видео) отправляются на сервер,
 *     а сервер ретранслирует их ВСЕМ остальным участникам комнаты.
 *  3. События, пришедшие ОТ СЕРВЕРА (т.е. от другого участника),
 *     применяются к локальному плееру, НО НЕ отправляются обратно
 *     (защита от петли событий / Event Loop Fix).
 *  4. Порог рассинхрона для принудительного seek — 0.5 секунды.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

// ID текущей комнаты (глобально). Критично для отправки сообщений
// и защиты от обращения к серверу с undefined roomId.
window.currentRoomId = null;

/* ═══════════════════════════════════════════════════════════
   0. КОНСТАНТЫ И СОСТОЯНИЕ
   ═══════════════════════════════════════════════════════════ */

const SYNC_THRESHOLD_SECONDS = 2;

const SOURCE_TYPES = {
  YOUTUBE: 'youtube',
  VIMEO: 'vimeo',
  HLS: 'hls',
  NATIVE: 'native',
  IFRAME: 'iframe',
  UNKNOWN: 'unknown'
};

const state = {
  socket: null,
  roomId: '',
  connected: false,

  currentType: SOURCE_TYPES.UNKNOWN,
  currentUrl: '',

  ytReady: false,
  ytPlayer: null,
  ytPlayerReady: false,
  pendingYouTubeVideoId: null,

  applyingRemote: false,
  isSyncing: false,
  currentPlaybackRate: 1.0,

  peers: [],
  viewers: 1,

  userName: 'Гость',
  userId: null,

  // Чат
  messages: [],
  replyTo: null, // { id, sender, text }

  // Реакции
  reactions: {}, // { messageId: { emoji: [userIds] } }
  recentReactions: JSON.parse(localStorage.getItem('recent_reactions')) || ['❤️', '💖', '😻', '🥰', '😂'],

  // Rave-система
  isHost: null,
  queue: [],
  serverTimeOffsetMs: 0,
  serverPingMs: 0,
  ytApiFailed: false,
  clockSyncInterval: null,
  syncInterval: null,
  vimeoReady: false,
  pendingSocketEvents: [],
  loadingSafetyTimer: null,
  isPlaying: false,
};

/* ═══════════════════════════════════════════════════════════
   1. УТИЛИТЫ / СНИППЕТЫ DOM
   ═══════════════════════════════════════════════════════════ */

const $ = (sel) => document.querySelector(sel);

const els = {
  // Шапка
  roomBadge: $('#roomBadge'),
  connStatus: $('#connStatus'),
  connText: $('#connText'),

  // Кнопки шапки
  changeMediaBtn: $('#changeMediaBtn'),
  inviteBtn: $('#inviteBtnHeader'),
  peersBtn: $('#peersBtnHeader'),
  peersCount: $('#peersCountHeader'),

  // Диагностика
  diagRoomState: $('#diagRoomState'),
  diagUrl: $('#diagUrl'),
  diagType: $('#diagType'),
  diagStatus: $('#diagStatus'),

  // Плеер
  placeholder: $('#placeholder'),
  ytHost: $('#ytPlayerHost'),
  videoHost: $('#videoHost'),
  nativeVideo: $('#nativeVideo'),
  iframeHost: $('#iframeHost'),
  embedFrame: $('#embedFrame'),
  nowPlayingTitle: $('#nowPlayingTitle'),

  // Чат
  chatMessages: $('#chatMessages'),
  chatEmpty: $('#chatEmpty'),
  chatInput: $('#chatInput'),
  chatSendBtn: $('#chatSendBtn'),

  // Боковая панель
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

  // Индикатор загрузки
  loadingOverlay: $('#loadingOverlay'),
  loadingText: $('#loadingText'),

  // Экран комнаты
  roomViewScreen: $('#room-view-screen'),
};

let snackbarEl = null;
let snackbarTimer = null;

/* ═══════════════════════════════════════════════════════════
   2. ИНИЦИАЛИЗАЦИЯ TELEGRAM WEBAPP SDK
   ═══════════════════════════════════════════════════════════ */

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
  } catch (e) { /* не критично */ }

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
  }

  console.log('[Telegram] initData →', {
    room: state.roomId,
    user: state.userName,
  });

  // Фиксируем высоту плеера по стабильной высоте вьюпорта Telegram.
  // При открытии клавиатуры уменьшаем плеер, чтобы дать больше места чату.
  const setPlayerHeight = () => {
    document.documentElement.style.setProperty('--player-h', '240px');
  };
  setPlayerHeight();

  tg.onEvent('viewportChanged', () => {
    setPlayerHeight();
    if (state.ytPlayer && typeof state.ytPlayer.getIframe === 'function') {
      requestAnimationFrame(() => {
        try { state.ytPlayer.getIframe(); } catch (e) { /* ignore */ }
      });
    }
  });
}

/**
 * Генерирует уникальный ID комнаты вида r_xxxxxxxxxx.
 */
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

/* ═══════════════════════════════════════════════════════════
   3. ПАРСЕР ССЫЛОК
   ═══════════════════════════════════════════════════════════ */

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

  // YouTube
  if (
    host === 'youtube.com' || host === 'www.youtube.com' ||
    host === 'm.youtube.com' || host === 'music.youtube.com' ||
    host === 'youtu.be' || host.endsWith('.youtube.com')
  ) {
    let videoId = null;

    if (host === 'youtu.be') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length > 0) videoId = parts[0];
    } else {
      const v = parsed.searchParams.get('v');
      if (v) {
        videoId = v;
      } else {
        const m = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/);
        if (m) videoId = m[1];
      }
    }

    if (videoId && /^[a-zA-Z0-9_-]{6,15}$/.test(videoId)) {
      return { type: SOURCE_TYPES.YOUTUBE, payload: { videoId } };
    }
    return { type: SOURCE_TYPES.UNKNOWN, payload: { error: 'Не удалось распознать YouTube-видео' } };
  }

  // Прямые медиа-файлы
  const directMediaExt = /\.(mp4|webm|ogg|ogv|mov|m4v)(\?.*)?$/i;
  if (directMediaExt.test(parsed.pathname)) {
    return { type: SOURCE_TYPES.NATIVE, payload: { url } };
  }

  // HLS
  if (parsed.pathname.toLowerCase().endsWith('.m3u8')) {
    return { type: SOURCE_TYPES.HLS, payload: { url } };
  }

  // Vimeo
  if (host.includes('vimeo.com')) {
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    const vimeoId = pathSegments.find((segment) => /^\d+$/.test(segment));
    if (vimeoId) {
      return { type: SOURCE_TYPES.VIMEO, payload: { videoId: vimeoId } };
    }
  }

  // VK / iframe
  const vkHosts = ['vk.com', 'm.vk.com', 'vkvideo.ru', 'vk.cc', 'vk.com/video'];
  if (
    vkHosts.includes(host) ||
    host.endsWith('.vk.com') ||
    host.endsWith('.vkvideo.ru') ||
    parsed.pathname.includes('/video') ||
    parsed.pathname.includes('/embed')
  ) {
    const embedUrl = buildEmbedUrl(parsed);
    if (embedUrl) {
      return { type: SOURCE_TYPES.IFRAME, payload: { embedUrl, originalUrl: url } };
    }
  }

  // Фолбэк: любой http(s) URL — iframe
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return { type: SOURCE_TYPES.IFRAME, payload: { embedUrl: url, originalUrl: url } };
  }

  return { type: SOURCE_TYPES.UNKNOWN, payload: null };
}

function buildEmbedUrl(parsed) {
  const host = parsed.hostname.toLowerCase();

  if (host === 'vkvideo.ru' || host === 'vk.com' || host === 'm.vk.com' || host.endsWith('.vkvideo.ru')) {
    const m = parsed.pathname.match(/video(-?\d+)_(\d+)/);
    if (m) {
      const [, oid, id] = m;
      return `https://vkvideo.ru/video_ext.php?oid=${encodeURIComponent(oid)}&id=${encodeURIComponent(id)}&hd=2`;
    }
  }

  if (parsed.pathname.includes('/video_ext.php')) {
    return parsed.href;
  }

  if (host.includes('vimeo.com')) {
    const videoId = parsed.pathname.split('/').filter(Boolean)[0];
    if (videoId && /^\d+$/.test(videoId)) {
      return `https://player.vimeo.com/video/${videoId}`;
    }
  }

  if (host === 'dailymotion.com' || host.endsWith('.dailymotion.com')) {
    const videoId = parsed.pathname.split('/').filter(Boolean).pop();
    if (videoId) {
      return `https://www.dailymotion.com/embed/video/${videoId}`;
    }
  }

  if (parsed.pathname.includes('/embed/')) {
    return parsed.href;
  }

  return null;
}

/* ═══════════════════════════════════════════════════════════
   4. ОБЩИЙ ПЕРЕКЛЮЧАТЕЛЬ ПЛЕЕРОВ
   ═══════════════════════════════════════════════════════════ */

function showOnlyShell(shellId) {
  const shells = {
    yt: $('#ytPlayerHost'),
    video: $('#videoHost'),
    iframe: $('#iframeHost'),
  };

  Object.entries(shells).forEach(([key, el]) => {
    if (!el) return;
    el.classList.toggle('hidden', key !== shellId);
  });

  const placeholder = $('#placeholder');
  if (placeholder) {
    placeholder.classList.toggle('hidden', shellId !== null);
  }
}

window.addEventListener('message', handleVimeoPostMessage, false);

function resetPlayers(keepVisible = false) {
  state.applyingRemote = true;
  state.vimeoReady = false;

  try { els.nativeVideo.pause(); } catch (e) { /* ignore */ }
  try { els.nativeVideo.removeAttribute('src'); } catch (e) { /* ignore */ }
  try { els.nativeVideo.load(); } catch (e) { /* ignore */ }
  els.nativeVideo.setAttribute('data-raw-url', '');
  if (typeof window.hlsInstance !== 'undefined' && window.hlsInstance) {
    try { window.hlsInstance.destroy(); } catch (e) { /* ignore */ }
    window.hlsInstance = null;
  }

  if (state.ytPlayer && typeof state.ytPlayer.destroy === 'function') {
    try { state.ytPlayer.destroy(); } catch (e) { /* ignore */ }
  }
  state.ytPlayer = null;
  state.ytPlayerReady = false;
  els.ytHost.innerHTML = '';

  try { els.embedFrame.src = 'about:blank'; } catch (e) { /* ignore */ }

  state.applyingRemote = false;
  state.currentUrl = '';

  if (!keepVisible) {
    showOnlyShell(null);

    const container = document.getElementById('player-container');
    if (container) {
      container.innerHTML = `
        <div class="player-placeholder" id="placeholder">
          <div class="placeholder-icon">🎥</div>
          <div class="placeholder-title">Начнём смотреть вместе?</div>
          <div class="placeholder-sub">
            Нажмите «Сменить видео» и вставьте ссылку.<br>
            Всё, что вы запускаете, синхронно увидит ваш собеседник.
          </div>
        </div>
        <div id="video-loader" style="display:none; position:absolute; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.7); z-index:10; align-items:center; justify-content:center; color:#fff; font-size:14px;">
          Загрузка видео…
        </div>
      `;
    }
  }
}

/**
 * Извлекает YouTube video ID из ссылки (упрощённый парсер для renderPlayer).
 */
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
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Монтирует плеер в DOM: iframe для YouTube / video для прямых ссылок.
 * Критично для инициализации плеера при получении ROOM_STATE / video-changed.
 */
function renderPlayer(url) {
  const container = document.getElementById('player-container');
  const welcome = document.getElementById('welcome-screen') || document.getElementById('placeholder');

  if (!container) return;

  // renderPlayer владеет #player-container — прячем «богатые» шеллы,
  // чтобы они не перекрывали fallback-плеер.
  ['#ytPlayerHost', '#videoHost', '#iframeHost'].forEach((sel) => {
    const shell = document.querySelector(sel);
    if (shell) shell.classList.add('hidden');
  });

  if (welcome) welcome.style.display = 'none';
  container.style.display = 'block';

  if (!url) {
    if (welcome) welcome.style.display = 'block';
    container.style.display = 'none';
    return;
  }

  // Fallback-плеер тоже «держит» currentUrl, чтобы не было рекурсивной
  // перезагрузки медиа на каждом ROOM_STATE.
  state.currentUrl = url;

  const ytId = extractYouTubeId(url);
  if (ytId) {
    container.innerHTML = `<iframe src="https://www.youtube.com/embed/${ytId}?autoplay=1&playsinline=1&rel=0" style="width:100%;height:100%;border:0;" allow="autoplay; fullscreen; encrypted-media" allowfullscreen></iframe>`;
  } else {
    container.innerHTML = `<video src="${url}" controls autoplay playsinline style="width:100%;height:100%;object-fit:contain;background:#000;"></video>`;
    const v = container.querySelector('video');
    if (v) {
      v.addEventListener('error', () => {
        console.error('[Player] Fallback видео не загрузилось:', url);
        setStatus('⚠️ Видео не загрузилось — сервер может блокировать внешние ссылки');
        showSnack('❌ Не удалось загрузить видео с этого источника');
      });
    }
  }
}

/**
 * Проверяет, смонтирован ли плеер через богатый пайплайн
 * (ytPlayerHost / videoHost / iframeHost).
 */
function isMediaMounted() {
  const ytHost = $('#ytPlayerHost');
  const videoHost = $('#videoHost');
  const iframeHost = $('#iframeHost');
  if (ytHost && !ytHost.classList.contains('hidden')) return true;
  if (videoHost && !videoHost.classList.contains('hidden')) return true;
  if (iframeHost && !iframeHost.classList.contains('hidden')) return true;
  return false;
}

/**
 * Проверяет, смонтирован ли fallback-плеер (renderPlayer) в #player-container.
 */
function isFallbackMounted() {
  const container = document.getElementById('player-container');
  if (!container) return false;
  return Boolean(container.querySelector('video, iframe'));
}

/* ═══════════════════════════════════════════════════════════
   5. YouTube ПЛЕЕР
   ═══════════════════════════════════════════════════════════ */

window.onYouTubeIframeAPIReady = function () {
  console.log('[YouTube] IFrame API готов');
  state.ytReady = true;
  state.ytApiFailed = false;
  ytApiAttempts = 0;
  hideLoading();

  if (state.pendingYouTubeVideoId) {
    loadYouTubeVideo(state.pendingYouTubeVideoId);
    state.pendingYouTubeVideoId = null;
  }
};

// Увеличиваем таймаут до 15 секунд и добавляем повторные попытки
let ytApiAttempts = 0;
const YT_API_MAX_ATTEMPTS = 3;

function tryLoadYouTubeApi() {
  if (state.ytReady) return;

  ytApiAttempts++;
  console.log(`[YouTube] Попытка загрузки API #${ytApiAttempts}`);

  if (state.ytReady) {
    hideLoading();
    return;
  }

  if (ytApiAttempts >= YT_API_MAX_ATTEMPTS) {
    console.error('[YouTube] API не загрузился за 15 секунд');
    state.ytApiFailed = true;
    setStatus('⚠️ YouTube API недоступен — включаю запасной iframe-плеер');
    showSnack('⚠️ YouTube API недоступен — включён запасной плеер');
    hideLoading();
    // Если есть отложенное видео — сразу монтируем iframe fallback
    if (state.pendingYouTubeVideoId) {
      renderPlayer('https://www.youtube.com/watch?v=' + state.pendingYouTubeVideoId);
      state.pendingYouTubeVideoId = null;
    }
    return;
  }

  if (!document.getElementById('yt-iframe-api-script')) {
    const tag = document.createElement('script');
    tag.id = 'yt-iframe-api-script';
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    document.head.appendChild(tag);
  }

  setTimeout(tryLoadYouTubeApi, 5000);
}

// Первая проверка через 15 секунд
setTimeout(() => {
  if (!state.ytReady) {
    tryLoadYouTubeApi();
  }
}, 15000);

function loadYouTubeVideo(videoId, autoplay = true) {
  // Если YouTube API точно недоступен (блокировка сети/расширением) —
  // сразу монтируем обычный <iframe>, НЕ требующий API.
  if (state.ytApiFailed) {
    console.warn('[YouTube] API недоступен — использую iframe fallback:', videoId);
    renderPlayer('https://www.youtube.com/watch?v=' + videoId);
    hideLoading();
    try {
      els.nowPlayingTitle.textContent = 'YouTube (iframe режим) — ' + videoId;
    } catch (e) { /* ignore */ }
    return;
  }

  if (!state.ytReady) {
    state.pendingYouTubeVideoId = videoId;
    setStatus('⏳ YouTube API загружается…');
    hideLoading();
    tryLoadYouTubeApi();

    // ── Fallback: если API не загрузился за 8 секунд (для гостей и хоста) —
    //    монтируем обычный <iframe>, НЕ требующий API.
    //    Это чинит случаи, когда ghcr/youtube заблокированы сетью.
    setTimeout(() => {
      if (!state.ytReady && !state.ytApiFailed && state.pendingYouTubeVideoId === videoId) {
        console.warn('[YouTube] API не загрузился за 8с — iframe fallback:', videoId);
        state.ytApiFailed = true;
        state.pendingYouTubeVideoId = null;
        renderPlayer('https://www.youtube.com/watch?v=' + videoId);
        hideLoading();
      }
    }, 8000);
    return;
  }

  const host = els.ytHost;
  host.classList.remove('hidden');
  showOnlyShell('yt');

  if (!state.ytPlayer) {
    host.innerHTML = `
      <div id="ytPlayer" class="youtube-player"
           style="width:100%;height:100%;"></div>
    `;

    state.ytPlayerReady = false;
    state.ytPlayer = new YT.Player('ytPlayer', {
      videoId,
      playerVars: {
        autoplay: autoplay ? 1 : 0,
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        origin: window.location.origin,
        muted: 1,
      },
      events: {
        onReady: (event) => {
          console.log('[YouTube] Плеер готов');
          state.ytPlayerReady = true;
          if (state.loadingSafetyTimer) { clearTimeout(state.loadingSafetyTimer); state.loadingSafetyTimer = null; }
          hideLoading();
          if (autoplay) {
            try { event.target.playVideo(); } catch (e) { /* ignore */ }

            setTimeout(() => {
              try {
                const currentState = event.target.getPlayerState();
                const isPlaying = currentState === YT.PlayerState.PLAYING ||
                                  currentState === YT.PlayerState.BUFFERING;
                if (!isPlaying) {
                  handleAutoplayBlocked('YouTube');
                }
              } catch (err) { /* ignore */ }
            }, 1500);
          }
        },
        onStateChange: handleYouTubeStateChange,
        onError: (event) => {
          console.error('[YouTube] Ошибка:', event.data);
          setStatus('⚠️ Ошибка YouTube-плеера (код ' + event.data + ')');
          showSnack('❌ Не удалось воспроизвести YouTube-видео');
          if (state.loadingSafetyTimer) { clearTimeout(state.loadingSafetyTimer); state.loadingSafetyTimer = null; }
          hideLoading();
          // Сбрасываем currentUrl, чтобы не оставаться в состоянии «URL есть, плеер сломан»
          state.currentUrl = '';
        },
      },
    });
  } else {
    // Плеер уже создан — скрываем загрузку сразу
    hideLoading();
    state.ytPlayer.loadVideoById(videoId, 0, autoplay ? 'large' : 'default');
  }
}

function handleVimeoPostMessage(event) {
  if (!event.origin.includes('vimeo.com')) return;
  const data = typeof event.data === 'object' && event.data ? event.data : null;
  if (!data || typeof data.event !== 'string') return;

  switch (data.event) {
    case 'ready':
      state.vimeoReady = true;
      if (state.loadingSafetyTimer) { clearTimeout(state.loadingSafetyTimer); state.loadingSafetyTimer = null; }
      hideLoading();
      setStatus('🎬 Vimeo плеер готов');
      break;
    case 'play':
      if (state.applyingRemote) return;
      emitIfNeeded('PLAY', {
        mediaType: SOURCE_TYPES.VIMEO,
        url: state.currentUrl,
        time: Number(data.seconds || 0),
      });
      break;
    case 'pause':
      if (state.applyingRemote) return;
      emitIfNeeded('PAUSE', {
        mediaType: SOURCE_TYPES.VIMEO,
        url: state.currentUrl,
        time: Number(data.seconds || 0),
      });
      break;
    case 'seeked':
      if (state.applyingRemote) return;
      emitIfNeeded('SEEK', {
        mediaType: SOURCE_TYPES.VIMEO,
        url: state.currentUrl,
        time: Number(data.seconds || 0),
      });
      break;
  }
}

function handleYouTubeStateChange(event) {
  if (state.applyingRemote) return;

  const YT_STATES = {
    [-1]: 'UNSTARTED',
    0: 'ENDED',
    1: 'PLAYING',
    2: 'PAUSED',
    3: 'BUFFERING',
    5: 'CUED',
  };

  const stateName = YT_STATES[event.data] || event.data;
  console.log('[YouTube] State →', stateName);

  switch (event.data) {
    case YT.PlayerState.PLAYING:
      emitIfNeeded('PLAY', {
        mediaType: SOURCE_TYPES.YOUTUBE,
        url: state.currentUrl,
        time: getYouTubeCurrentTime(),
      });
      break;

    case YT.PlayerState.PAUSED:
      emitIfNeeded('PAUSE', {
        mediaType: SOURCE_TYPES.YOUTUBE,
        url: state.currentUrl,
        time: getYouTubeCurrentTime(),
      });
      break;

    case YT.PlayerState.ENDED:
      emitIfNeeded('PAUSE', {
        mediaType: SOURCE_TYPES.YOUTUBE,
        url: state.currentUrl,
        time: getYouTubeCurrentTime(),
      });
      break;
  }
}

function getYouTubeCurrentTime() {
  if (state.ytPlayer && typeof state.ytPlayer.getCurrentTime === 'function') {
    try { return state.ytPlayer.getCurrentTime(); } catch (e) { return 0; }
  }
  return 0;
}

/* ═══════════════════════════════════════════════════════════
   6. HTML5 VIDEO / HLS ПЛЕЕР
   ═══════════════════════════════════════════════════════════ */

function loadNativeOrHls(url, autoplay = true) {
  const video = els.nativeVideo;
  video.setAttribute('data-raw-url', url);
  showOnlyShell('video');

  // ── Fallback: если видео не начало грузиться за 8с или произошла ошибка —
  //    монтируем «голый» <video> с контролами через renderPlayer.
  //    Это чинит случаи, когда сервер блокирует запрос (Referer/CORS/хотлинк).
  let fallbackDone = false;
  const fallbackTimer = setTimeout(() => {
    if (video.readyState === 0 && !fallbackDone) {
      fallbackDone = true;
      console.warn('[Video] Загрузка зависла — fallback renderPlayer:', url);
      hideLoading();
      renderPlayer(url);
    }
  }, 8000);

  const fallbackOnError = () => {
    if (fallbackDone) return;
    fallbackDone = true;
    clearTimeout(fallbackTimer);
    console.warn('[Video] Ошибка загрузки — fallback renderPlayer:', url);
    hideLoading();
    // renderPlayer сам запишет state.currentUrl — не даём циклу перезагрузки
    renderPlayer(url);
  };

  video.addEventListener('loadedmetadata', () => {
    clearTimeout(fallbackTimer);
    hideLoading();
  }, { once: true });

  video.addEventListener('error', fallbackOnError, { once: true });

  if (url.toLowerCase().endsWith('.m3u8')) {
    if (window.Hls && Hls.isSupported()) {
      if (window.hlsInstance) {
        try { window.hlsInstance.destroy(); } catch (e) { /* ignore */ }
      }
      window.hlsInstance = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        enableWorker: true,
      });

      window.hlsInstance.loadSource(url);
      window.hlsInstance.attachMedia(video);

      window.hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        clearTimeout(fallbackTimer);
        hideLoading();
        setStatus('📡 HLS поток готов');
        if (autoplay) {
          video.play().catch(() => handleAutoplayBlocked('HLS'));
        }
      });

      window.hlsInstance.on(Hls.Events.ERROR, (event, data) => {
        if (data && data.fatal) {
          console.error('[HLS] Фатальная ошибка:', data);
          setStatus('⚠️ Ошибка HLS-потока');
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              window.hlsInstance.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              window.hlsInstance.recoverMediaError();
              break;
            default:
              state.currentUrl = '';
              fallbackOnError();
              break;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.addEventListener('loadedmetadata', () => {
        clearTimeout(fallbackTimer);
        hideLoading();
        setStatus('📡 HLS поток готов (нативно)');
        if (autoplay) video.play().catch(() => handleAutoplayBlocked('HLS'));
      }, { once: true });
    } else {
      console.error('[HLS] HLS.js недоступен');
      setStatus('⚠️ HLS не поддерживается на этом устройстве');
      hideLoading();
      fallbackOnError();
    }
  } else {
    video.src = url;
    video.load();
    if (autoplay) {
      video.play().catch(() => handleAutoplayBlocked('видео'));
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   7. IFRAME ПЛЕЕР (VK Video и др.)
   ═══════════════════════════════════════════════════════════ */

function loadIframe(embedUrl) {
  showOnlyShell('iframe');
  els.embedFrame.src = embedUrl;
  state.vimeoReady = false;
  setTimeout(() => {
    hideLoading();
    setStatus('🖥 Встроенный плеер — синхронизация ограничена');
  }, 1500);
}

function loadVimeoVideo(videoId, autoplay = true) {
  showOnlyShell('iframe');
  state.vimeoReady = false;
  const url = `https://player.vimeo.com/video/${encodeURIComponent(videoId)}?api=1&player_id=vimeo_player&autoplay=${autoplay ? 1 : 0}&transparent=0&dnt=1`;
  els.embedFrame.src = url;
  setStatus('⏳ Vimeo загружается…');
}

/* ═══════════════════════════════════════════════════════════
   8. ОСНОВНАЯ ТОЧКА ВХОДА ЗАГРУЗКИ МЕДИА
   ═══════════════════════════════════════════════════════════ */

function loadMedia(rawUrl, opts = {}) {
  const { emit = true, autoplay = true, incoming = false } = opts;

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

  resetPlayers(true);
  showLoading('Загрузка видео…');

  if (state.loadingSafetyTimer) clearTimeout(state.loadingSafetyTimer);
  state.loadingSafetyTimer = setTimeout(() => {
    hideLoading();
    state.loadingSafetyTimer = null;
  }, 10000);

  switch (parsed.type) {
    case SOURCE_TYPES.YOUTUBE:
      loadYouTubeVideo(parsed.payload.videoId, autoplay);
      break;

    case SOURCE_TYPES.VIMEO:
      loadVimeoVideo(parsed.payload.videoId, autoplay);
      break;

    case SOURCE_TYPES.HLS:
    case SOURCE_TYPES.NATIVE:
      loadNativeOrHls(parsed.payload.url, autoplay);
      break;

    case SOURCE_TYPES.IFRAME:
      loadIframe(parsed.payload.embedUrl);
      break;

    default:
      setStatus('⚠️ Неизвестный тип медиа');
      hideLoading();
      return false;
  }

  // Устанавливаем currentUrl только после успешного запуска загрузки.
  // Если плеер сообщит об ошибке — currentUrl будет сброшен в обработчике ошибок.
  state.currentUrl = trimmedUrl;

  // Обновляем "Сейчас играет"
  els.nowPlayingTitle.textContent = formatTitle(state.currentUrl);

  if (emit && !incoming) {
    emitIfNeeded('CHANGE_MEDIA', {
      mediaType: parsed.type,
      url: state.currentUrl,
      time: 0,
    });
  }

  closeDrawer();

  return true;
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

function ensureCorrectPlayer(videoUrl, autoplay = true) {
  if (!videoUrl) return;
  const parsed = parseUrl(videoUrl);
  if (parsed.type === SOURCE_TYPES.UNKNOWN) {
    console.warn('[Player] Не удалось определить тип медиа:', videoUrl);
    return;
  }
  loadMedia(videoUrl, { emit: false, autoplay, incoming: true });
}

/* ═══════════════════════════════════════════════════════════
   9. SOCKET.IO — ПОДКЛЮЧЕНИЕ И ОБРАБОТКА СОБЫТИЙ
   ═══════════════════════════════════════════════════════════ */

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
    setStatus('🟢 Подключено к лобби');
    showSnack('🟢 Подключено к лобби');
    startClockSync();
    if (state.roomId) {
      window.currentRoomId = state.roomId;
      s.emit('join-room', { roomId: state.roomId });
    }
    flushPendingSocketEvents();
  });

  s.on('disconnect', (reason) => {
    state.connected = false;
    updateConnUI(false);
    console.warn('[Socket] Отключено:', reason);
    setStatus('🔴 Нет соединения с сервером');
    stopClockSync();
    stopPeriodicSync();
  });

  s.on('PONG', (data) => {
    handlePong(data);
  });

  s.on('connect_error', (err) => {
    console.error('[Socket] Ошибка подключения:', err.message);
    setStatus('🔴 Ошибка подключения');
  });

  s.on('hello', (data) => {
    console.log('[Socket] hello →', data);
    state.isHost = !!data.isHost;
    if (typeof data.viewers === 'number') {
      state.viewers = data.viewers;
      updatePeersCount();
    }
    updateHostUI();
    flushPendingSocketEvents();

    if (state.isHost) {
      startPeriodicSync();
    } else {
      stopPeriodicSync();
    }
  });

  // ── Инициализация комнаты для нового участника ────────────
  // Сервер отправляет init-room-state при подключении:
  // текущий URL, таймкод и статус воспроизведения.
  // Автоматически инициализируем плеер, перематываем и запускаем,
  // если хост уже смотрит видео.
  const applyRoomState = (data) => {
    console.log('[Socket] room-state ←', data);

    const roomUrl = data.currentUrl;
     // Server-authoritative: вычисляем позицию по anchorTime/anchorTimestamp
     const roomTime = getServerAuthoritativePosition(data);
    const roomPlaying = !!data.isPlaying;

    // Применяем currentType до инициализации плеера
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
        handleRemoteMedia({
          mediaType: state.currentType,
          url: roomUrl,
          time: roomTime,
          autoplay: roomPlaying,
        });
      } else if (state.currentUrl === roomUrl) {
        if (roomPlaying) {
          handleRemotePlay({
            mediaType: state.currentType,
            url: roomUrl,
            time: roomTime,
          });
        } else {
          handleRemotePause({
            mediaType: state.currentType,
            url: roomUrl,
            time: roomTime,
          });
        }
      }
    } else if (state.currentUrl) {
      resetPlayers();
    }

    if (Array.isArray(data.queue)) {
      state.queue = data.queue;
      renderQueue();
    }
  };

  // Основной канал: приходит от сервера сразу после hello
  s.on('init-room-state', applyRoomState);

  // Фолбэк: если сервер/старый клиент ещё шлёт ROOM_STATE
  s.on('ROOM_STATE', (data) => {
    applyRoomState(data);
    // Гарантия монтирования плеера (фолбэк, если rich-пайплайн не сработал)
    if (data && data.currentUrl && !isMediaMounted() && !isFallbackMounted()) {
      renderPlayer(data.currentUrl);
    }
  });

  // ── Смена видео (простой путь) ─────────────────────────────
  s.on('video-changed', ({ url } = {}) => {
    console.log('[Socket] video-changed ←', url);
    renderPlayer(url);
  });

  // ── Смена хоста ────────────────────────────────────────────
  s.on('HOST_CHANGED', ({ hostId }) => {
    console.log('[Socket] HOST_CHANGED ←', hostId);
    state.isHost = hostId === state.socket.id;
    updateHostUI();
    showSnack(state.isHost ? '👑 Вы теперь хост' : '👑 Хост сменился');

    if (state.isHost) {
      startPeriodicSync();
    } else {
      stopPeriodicSync();
    }
  });

  // ── Rave: Server-side Master Clock + Dynamic Playback Rate ─────
  // Сервер рассылает sync-state с серверным временем и timestamp ответа.
  // Клиент компенсирует ping, затем плавно подстраивает playbackRate.
  s.on('sync-state', ({ serverTime, isPlaying, serverTimestamp }) => {
    if (state.isHost) return; // Хост — источник истины, не синхронизируемся сам с собой

    const player = getActivePlayer();
    if (!player) return;

    // А. Ping Compensation — компенсируем сетевую задержку
    const latency = (Date.now() - serverTimestamp) / 2000;
    const targetTime = serverTime + latency;
    const localTime = player.getCurrentTime();
    const diff = targetTime - localTime;

    state.isSyncing = true; // Блокируем отправку локальных событий

    // Б. Состояние Play / Pause — только при реальном рассинхроне состояния
    const isPlayerPaused = player.isPaused();
    if (isPlaying && isPlayerPaused) {
      player.play();
      player.setPlaybackRate(state.currentPlaybackRate);
      setTimeout(() => { state.isSyncing = false; }, 400);
      return;
    } else if (!isPlaying && !isPlayerPaused) {
      player.pause();
      player.setPlaybackRate(1.0);
      state.currentPlaybackRate = 1.0;
      setTimeout(() => { state.isSyncing = false; }, 300);
      return;
    }

    if (!isPlaying && isPlayerPaused) {
      // Paused on both sides — просто синхронизируем позицию если сильно отстаём
      if (Math.abs(diff) > 2.5) {
        player.seekTo(targetTime);
      }
      setTimeout(() => { state.isSyncing = false; }, 400);
      return;
    }

    // В. Логика Rave: дифференциальная подстройка вместо каскада пауз
    const absDiff = Math.abs(diff);

    if (absDiff > 2.5) {
      player.seekTo(targetTime);
      player.setPlaybackRate(1.0);
      state.currentPlaybackRate = 1.0;
    } else if (diff > 0.3) {
      if (state.currentPlaybackRate !== 1.05) {
        player.setPlaybackRate(1.05);
        state.currentPlaybackRate = 1.05;
      }
    } else if (diff < -0.3) {
      if (state.currentPlaybackRate !== 0.95) {
        player.setPlaybackRate(0.95);
        state.currentPlaybackRate = 0.95;
      }
    } else {
      if (state.currentPlaybackRate !== 1.0) {
        player.setPlaybackRate(1.0);
        state.currentPlaybackRate = 1.0;
      }
    }

    setTimeout(() => { state.isSyncing = false; }, 400);
  });

  // ── Обновление списка комнат ────────────────────────────────
  s.on('rooms-updated', (rooms) => {
    console.log('[Socket] rooms-updated ←', rooms);
    renderRoomsList(rooms);
  });

  // ── Очередь обновлена ──────────────────────────────────────
  s.on('QUEUE_UPDATED', ({ queue }) => {
    console.log('[Socket] QUEUE_UPDATED ←', queue);
    state.queue = Array.isArray(queue) ? queue : [];
    renderQueue();
  });

  // ── Ошибка (например, гость пытается управлять видео) ─────
  s.on('ERROR', ({ message }) => {
    console.warn('[Socket] ERROR ←', message);
    showSnack('⚠️ ' + message);
  });

  // ── Ивенты синхронизации ─────────────────────────────────
  // В server-authoritative архитектуре (как в Rave) клиент получает
  // только ROOM_STATE — полное состояние комнаты после каждого изменения.
  // Отдельные события PLAY/PAUSE/SEEK/CHANGE_MEDIA не отправляются.

  s.on('USER_LEFT', ({ id, viewers }) => {
    console.log('[Sync] USER_LEFT ←', id, '| viewers:', viewers);
    state.peers = state.peers.filter((p) => p.id !== id);
    if (typeof viewers === 'number') {
      state.viewers = viewers;
    }
    updatePeersCount();
    renderDrawerPeers();
    showSnack('👋 Участник покинул комнату');
  });

  s.on('USER_JOINED', ({ id, isHost, viewers }) => {
    console.log('[Sync] USER_JOINED ←', id, '| viewers:', viewers);
    if (typeof viewers === 'number') {
      state.viewers = viewers;
      updatePeersCount();
      renderDrawerPeers();
    }
    showSnack('👤 Новый участник в комнате (' + (viewers || state.viewers) + ' 👥)');
  });

  s.on('PEERS', ({ peers, count }) => {
    console.log('[Sync] PEERS ←', peers, '| count:', count);
    state.peers = peers.map((id, i) => ({
      id,
      name: i === 0 ? 'Участник 1' : 'Участник ' + (i + 1),
    }));
    updatePeersCount();
    renderDrawerPeers();
  });

  // ── Чат ───────────────────────────────────────────────────
  s.on('CHAT', (data) => {
    console.log('[Chat] ←', data);
    addChatMessage(data, data.socketId === state.socket?.id);
  });

  s.on('new-message', (data) => {
    console.log('[Chat] new-message ←', data);
    addChatMessage(data, data.senderId === state.socket?.id);
  });

  s.on('CHAT_HISTORY', ({ messages }) => {
    console.log('[Chat] История ←', messages.length, 'сообщений');
    if (Array.isArray(messages)) {
      state.messages = [];
      els.chatMessages.innerHTML = '';
      checkChatEmpty();
      messages.forEach((msg) => addChatMessage(msg, msg.socketId === state.socket?.id));
    }
  });

  // ── Реакции на сообщения ───────────────────────────────────
  // FIX 1: Синхронизация реакций через Socket.io
  s.on('message-reaction-updated', ({ messageId, emoji, userId, reactions }) => {
    console.log('[Reactions] ←', messageId, emoji, userId);
    state.reactions[messageId] = reactions || {};
    updateMessageReactionDOM(messageId, emoji, userId);
  });

  // Получаем все реакции при подключении
  s.on('ALL_REACTIONS', ({ reactions }) => {
    console.log('[Reactions] ALL ←', reactions);
    if (reactions && typeof reactions === 'object') {
      state.reactions = reactions;
      // Перерисовываем все сообщения с реакциями
      Object.keys(reactions).forEach((messageId) => {
        renderMessageReactions(messageId);
      });
    }
  });
}

// ─── Rave: Отправка действий пользователя с защитой от петли ───
function onUserPlay() {
  if (state.isSyncing) return;
  const player = getActivePlayer();
  if (!player) return;
  const time = player.getCurrentTime();
  state.socket.emit('player-action', {
    roomId: state.roomId,
    action: 'play',
    time,
  });
}

function onUserPause() {
  if (state.isSyncing) return;
  const player = getActivePlayer();
  if (!player) return;
  const time = player.getCurrentTime();
  state.socket.emit('player-action', {
    roomId: state.roomId,
    action: 'pause',
    time,
  });
}

function onUserSeek(newTime) {
  if (state.isSyncing) return;
  state.socket.emit('player-action', {
    roomId: state.roomId,
    action: 'seek',
    time: newTime,
  });
}

function emitIfNeeded(eventName, payload) {
  if (state.applyingRemote) {
    console.log('[Emit] Пропуск (applyingRemote)', eventName);
    return;
  }
  if (state.isSyncing) {
    console.log('[Emit] Пропуск (isSyncing)', eventName);
    return;
  }
  // Только хост может управлять видео (как в Rave)
  if (!state.isHost && ['PLAY', 'PAUSE', 'SEEK', 'CHANGE_MEDIA', 'player-action'].includes(eventName)) {
    console.warn('[Emit] Гость не может управлять видео:', eventName);
    return;
  }
  if (!state.socket || !state.connected || state.isHost === null) {
    console.warn('[Emit] Сохранено до готовности:', eventName);
    state.pendingSocketEvents.push({ eventName, payload: { ...payload, sender: state.userName || state.socket?.id } });
    showSnack('⌛ Жду соединения и роль хоста, скоро синхронизирую');
    return;
  }

  if (!state.isHost && ['PLAY', 'PAUSE', 'SEEK', 'CHANGE_MEDIA'].includes(eventName)) {
    console.warn('[Emit] Гость не может управлять видео:', eventName);
    return;
  }

  state.socket.emit(eventName, {
    ...payload,
    sender: state.userName || state.socket.id,
  });
}

function flushPendingSocketEvents() {
  if (!state.socket || !state.connected || state.pendingSocketEvents.length === 0) return;
  if (state.isHost === null) return;

  const preserved = [];
  while (state.pendingSocketEvents.length > 0) {
    const { eventName, payload } = state.pendingSocketEvents.shift();
    if (!state.isHost && ['PLAY', 'PAUSE', 'SEEK', 'CHANGE_MEDIA'].includes(eventName)) {
      preserved.push({ eventName, payload });
      continue;
    }
    console.log('[Emit] Выполняем отложенное событие:', eventName, payload);
    state.socket.emit(eventName, payload);
  }
  state.pendingSocketEvents = preserved.concat(state.pendingSocketEvents);
}

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

function getServerNowMs() {
  return Date.now() + state.serverTimeOffsetMs;
}

function getAdjustedRemoteTime(data) {
  const baseTime = typeof data.time === 'number' ? data.time : 0;
  if (typeof data.serverTime !== 'number') return baseTime;
  const elapsed = (getServerNowMs() - data.serverTime) / 1000;
  return Math.max(0, baseTime + elapsed);
}

/**
 * Server-authoritative позиция (как в Rave):
 * если есть anchorTimestamp и isPlaying — вычисляем текущую позицию по серверному времени.
 */
function getServerAuthoritativePosition(data) {
  if (data.isPlaying && typeof data.anchorTimestamp === 'number') {
    const anchorTime = typeof data.anchorTime === 'number' ? data.anchorTime : 0;
    const elapsed = (getServerNowMs() - data.anchorTimestamp) / 1000;
    return Math.max(0, anchorTime + elapsed);
  }
  return typeof data.anchorTime === 'number' ? data.anchorTime : 0;
}

/* ═══════════════════════════════════════════════════
   10. ОБРАБОТЧИКИ REMOTE-КОМАНД
   ═══════════════════════════════════════════════════════════ */

function withRemoteFlag(fn) {
  state.applyingRemote = true;
  try {
    fn();
  } finally {
    setTimeout(() => {
      state.applyingRemote = false;
    }, 500);
  }
}

function handleRemotePlay(data) {
  state.isPlaying = true;
  const type = data.mediaType || state.currentType;
  const targetTime = getAdjustedRemoteTime(data);

  if (data.url && data.url !== state.currentUrl) {
    handleRemoteMedia({ ...data, autoplay: false });
  }

  withRemoteFlag(() => {
    switch (type) {
      case SOURCE_TYPES.YOUTUBE: {
        const player = getPlayerInterface();
        if (!player) return;
        if (targetTime > 0 && Math.abs(player.getCurrentTime() - targetTime) > SYNC_THRESHOLD_SECONDS) {
          player.seekTo(targetTime);
        }
        player.play();
        break;
      }

      case SOURCE_TYPES.NATIVE:
      case SOURCE_TYPES.HLS: {
        const video = els.nativeVideo;
        const desired = targetTime || 0;

        if (video.readyState < 2 && desired > 0) {
          video.addEventListener('loadedmetadata', () => {
            try { video.currentTime = desired; } catch (e) { /* ignore */ }
          }, { once: true });
        } else if (Math.abs((video.currentTime || 0) - desired) > SYNC_THRESHOLD_SECONDS && desired > 0) {
          video.currentTime = desired;
        }

        video.play().catch(() => handleAutoplayBlocked('видео'));
        break;
      }

      case SOURCE_TYPES.VIMEO: {
        const iframe = els.embedFrame;
        const win = iframe.contentWindow;
        if (win) {
          if (targetTime > 0) {
            win.postMessage({ method: 'setCurrentTime', value: targetTime }, '*');
          }
          win.postMessage({ method: 'play' }, '*');
        }
        break;
      }
      case SOURCE_TYPES.IFRAME:
        console.warn('[Sync] PLAY для iframe — синхронизация времени невозможна, пропускаем');
        break;
    }
  });
  setStatus('▶ Воспроизведение (от партнёра)');
}

function handleRemotePause(data) {
  state.isPlaying = false;
  const type = data.mediaType || state.currentType;

  if (data.url && data.url !== state.currentUrl) {
    handleRemoteMedia({ ...data, autoplay: false });
  }

  withRemoteFlag(() => {
    switch (type) {
      case SOURCE_TYPES.YOUTUBE: {
        const player = getPlayerInterface();
        if (player) player.pause();
        break;
      }

      case SOURCE_TYPES.NATIVE:
      case SOURCE_TYPES.HLS:
        els.nativeVideo.pause();
        break;

      case SOURCE_TYPES.VIMEO: {
        const iframe = els.embedFrame;
        const win = iframe.contentWindow;
        if (win) {
          win.postMessage({ method: 'pause' }, '*');
        }
        break;
      }
      case SOURCE_TYPES.IFRAME:
        console.warn('[Sync] PAUSE для iframe — синхронизация невозможна, пропускаем');
        break;
    }
  });
  setStatus('⏸ Пауза (от партнёра)');
}

function handleRemoteSeek(data) {
  const type = data.mediaType || state.currentType;
  const seekTo = getAdjustedRemoteTime(data);

  if (data.url && data.url !== state.currentUrl) {
    handleRemoteMedia({ ...data, autoplay: false });
  }

  withRemoteFlag(() => {
    switch (type) {
      case SOURCE_TYPES.YOUTUBE: {
        const player = getPlayerInterface();
        if (player && Math.abs(player.getCurrentTime() - seekTo) > SYNC_THRESHOLD_SECONDS) {
          player.seekTo(seekTo);
        }
        break;
      }

      case SOURCE_TYPES.NATIVE:
      case SOURCE_TYPES.HLS: {
        const video = els.nativeVideo;
        if (video.readyState < 2) {
          video.addEventListener('loadedmetadata', () => {
            try { video.currentTime = seekTo; } catch (e) { /* ignore */ }
          }, { once: true });
        } else if (Math.abs((video.currentTime || 0) - seekTo) > SYNC_THRESHOLD_SECONDS) {
          video.currentTime = seekTo;
        }
        break;
      }

      case SOURCE_TYPES.VIMEO: {
        const iframe = els.embedFrame;
        const win = iframe.contentWindow;
        if (win) {
          win.postMessage({ method: 'setCurrentTime', value: seekTo }, '*');
        }
        break;
      }
      case SOURCE_TYPES.IFRAME:
        console.warn('[Sync] SEEK для iframe — синхронизация невозможна, пропускаем');
        break;
    }
  });
  setStatus('⏩ Перемотка (от партнёра)');
}

function handleRemoteMedia(data) {
  const { url, mediaType, autoplay = true } = data;
  const time = getAdjustedRemoteTime(data);

  if (!url) return;

  const type = mediaType || state.currentType;
  const sameUrl = url === state.currentUrl;

  const scheduleRemoteSync = () => {
    let attempts = 0;
    const maxAttempts = 10;
    const retryInterval = setInterval(() => {
      attempts++;
      const ready = isPlayerReady(type);

      if (ready) {
        clearInterval(retryInterval);

        if (type === SOURCE_TYPES.IFRAME) {
          console.warn('[Sync] IFRAME не синхронизируется (play/pause/seek недоступны)');
          return;
        }

        // time уже скорректирован getAdjustedRemoteTime —
        // убираем serverTime, чтобы время не прибавлялось второй раз.
        const syncData = { ...data, mediaType: type, serverTime: undefined };
        if (typeof time === 'number' && time > 0) {
          handleRemoteSeek({ ...syncData, time });
        }
        if (autoplay) {
          handleRemotePlay({ ...syncData, time });
        }
      } else if (attempts >= maxAttempts) {
        clearInterval(retryInterval);
        console.warn('[Sync] Плеер не стал готов за ' + maxAttempts + ' попыток');
      }
    }, 500);
  };

  // Если URL тот же, но плеер ещё не готов — перезагружаем медиа и ставим синхронизацию на готовность
  if (sameUrl && !isPlayerReady(type)) {
    console.log('[Sync] Тот же URL, но плеер не готов — повторно загружаем медиа', type, url);
    ensureCorrectPlayer(url, autoplay);
    scheduleRemoteSync();
    return;
  }

  if (sameUrl && isPlayerReady(type)) {
    // time уже скорректирован getAdjustedRemoteTime —
    // убираем serverTime, чтобы время не прибавлялось второй раз.
    const syncData = { ...data, mediaType: type, serverTime: undefined };
    if (time > 0) {
      handleRemoteSeek({ ...syncData, time });
    }
    if (autoplay) {
      handleRemotePlay({ ...syncData, time });
    }
    return;
  }

  console.log('[Sync] Загружаем удалённое медиа:', mediaType, url);

  ensureCorrectPlayer(url, autoplay);

  scheduleRemoteSync();
}

/**
 * Проверяет, готов ли плеер для данного типа медиа.
 */
function isPlayerReady(type) {
  switch (type) {
    case SOURCE_TYPES.YOUTUBE:
      return !!(state.ytPlayer && state.ytPlayerReady && typeof state.ytPlayer.playVideo === 'function');
    case SOURCE_TYPES.NATIVE:
    case SOURCE_TYPES.HLS:
      return els.nativeVideo.readyState >= 1;
    case SOURCE_TYPES.IFRAME:
      return true; // iframe не требует готовности
    default:
      return false;
  }
}

/* ═══════════════════════════════════════════════════════════
   11. СИНХРОНИЗАЦИЯ ВРЕМЕНИ
   ═══════════════════════════════════════════════════════════ */

function getCurrentPlayhead() {
  const player = getPlayerInterface();
  return player ? player.getCurrentTime() : 0;
}

function syncYouTubeTime(desired) {
  if (!state.ytPlayer || typeof state.ytPlayer.getCurrentTime !== 'function') return;

  try {
    const current = state.ytPlayer.getCurrentTime();
    if (Math.abs(desired - current) > SYNC_THRESHOLD_SECONDS) {
      console.log(`[Sync] Расхождение YouTube: ${current.toFixed(2)} → ${desired.toFixed(2)}`);
      state.ytPlayer.seekTo(desired, true);
    }
  } catch (e) { /* ignore */ }
}

function getActivePlayer() {
  if (state.ytPlayer && state.ytPlayerReady) {
    return {
      getCurrentTime: () => {
        try { return state.ytPlayer.getCurrentTime(); } catch (e) { return 0; }
      },
      play: () => {
        try { state.ytPlayer.playVideo(); } catch (e) { /* ignore */ }
      },
      pause: () => {
        try { state.ytPlayer.pauseVideo(); } catch (e) { /* ignore */ }
      },
      seekTo: (time) => {
        try { state.ytPlayer.seekTo(time, true); } catch (e) { /* ignore */ }
      },
      isPaused: () => {
        try { return state.ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING; } catch (e) { return true; }
      },
      setPlaybackRate: (rate) => {
        try { state.ytPlayer.setPlaybackRate(rate); } catch (e) { /* ignore */ }
      },
      setCurrentTime: (time) => {
        try { state.ytPlayer.seekTo(time, true); } catch (e) { /* ignore */ }
      },
    };
  }
  const video = els.nativeVideo;
  if (video && video.readyState >= 1) {
    return {
      getCurrentTime: () => video.currentTime || 0,
      play: () => video.play().catch(() => {}),
      pause: () => video.pause(),
      seekTo: (time) => { video.currentTime = time; },
      isPaused: () => video.paused,
      setPlaybackRate: (rate) => { video.playbackRate = rate; },
      setCurrentTime: (time) => { video.currentTime = time; },
    };
  }
  return null;
}

function getPlayerInterface() {
  if (state.ytPlayer && state.ytPlayerReady) {
    return {
      getCurrentTime: () => {
        try { return state.ytPlayer.getCurrentTime(); } catch (e) { return 0; }
      },
      play: () => {
        try { state.ytPlayer.playVideo(); } catch (e) { /* ignore */ }
      },
      pause: () => {
        try { state.ytPlayer.pauseVideo(); } catch (e) { /* ignore */ }
      },
      seekTo: (time) => {
        try { state.ytPlayer.seekTo(time, true); } catch (e) { /* ignore */ }
      },
      isPlaying: () => {
        try { return state.ytPlayer.getPlayerState() === YT.PlayerState.PLAYING; } catch (e) { return false; }
      }
    };
  }
  const video = els.nativeVideo;
  if (video && video.readyState >= 1) {
    return {
      getCurrentTime: () => video.currentTime || 0,
      play: () => video.play().catch(() => {}),
      pause: () => video.pause(),
      seekTo: (time) => { video.currentTime = time; },
      isPlaying: () => !video.paused
    };
  }
  return null;
}

function setSupportedSpeed(player, speed) {
  try {
    if (player && typeof player.setPlaybackRate === 'function') {
      player.setPlaybackRate(speed);
    } else {
      const iframe = document.getElementById('yt-player-iframe');
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage(JSON.stringify({
          event: 'command',
          func: 'setPlaybackRate',
          args: [speed]
        }), '*');
      }
    }
  } catch (e) {
    console.error("Ошибка при смене скорости:", e);
  }
}

function applyVideoSync(targetTime, isPaused) {
  const player = getPlayerInterface();
  if (!player) return;

  const currentTime = player.getCurrentTime();
  const timeDiff = Math.abs(currentTime - targetTime);

  if (isPaused) {
    player.pause();
    return;
  }

  if (!player.isPlaying()) {
    player.play();
  }

  if (timeDiff > SYNC_THRESHOLD_SECONDS) {
    player.seekTo(targetTime);
  }
}

function startPeriodicSync() {
  stopPeriodicSync();
  state.syncInterval = setInterval(() => {
    if (!state.isHost || !state.socket || !state.connected) return;
    if (!state.currentUrl) return;

    const currentTime = getCurrentPlayhead();
    state.socket.emit('sync-video', {
      currentTime,
      isPaused: !state.isPlaying,
    });
  }, 3000);
}

function stopPeriodicSync() {
  if (state.syncInterval) {
    clearInterval(state.syncInterval);
    state.syncInterval = null;
  }
}

// В server-authoritative архитектуре (как в Rave) таймеры не нужны:
// сервер сам отправляет ROOM_STATE после каждого изменения.

/* ═══════════════════════════════════════════════════════════
   12. СОБЫТИЯ ЛОКАЛЬНОГО HTML5-ПЛЕЕРА
   ═══════════════════════════════════════════════════════════ */

function bindNativeVideoEvents() {
  const video = els.nativeVideo;

  video.addEventListener('play', () => {
    if (state.applyingRemote) return;
    emitIfNeeded('PLAY', {
      mediaType: SOURCE_TYPES.NATIVE,
      url: state.currentUrl,
      time: video.currentTime,
    });
  });

  video.addEventListener('pause', () => {
    if (state.applyingRemote) return;
    emitIfNeeded('PAUSE', {
      mediaType: SOURCE_TYPES.NATIVE,
      url: state.currentUrl,
      time: video.currentTime,
    });
  });

  video.addEventListener('seeked', () => {
    if (state.applyingRemote) return;
    emitIfNeeded('SEEK', {
      mediaType: SOURCE_TYPES.NATIVE,
      url: state.currentUrl,
      time: video.currentTime,
    });
  });

  video.addEventListener('ended', () => {
    emitIfNeeded('PAUSE', {
      mediaType: SOURCE_TYPES.NATIVE,
      url: state.currentUrl,
      time: video.duration || video.currentTime,
    });
  });

  video.addEventListener('error', (e) => {
    console.error('[Video] Ошибка:', e);
    setStatus('⚠️ Ошибка воспроизведения видео');
    showSnack('❌ Не удалось воспроизвести видео');
    hideLoading();
    // Сбрасываем currentUrl, чтобы не оставаться в состоянии «URL есть, плеер сломан»
    state.currentUrl = '';
  });
}

/* ═══════════════════════════════════════════════════════════
   13. UI-ХЕЛПЕРЫ
   ═══════════════════════════════════════════════════════════ */

// Статус теперь выводится в snackbar, т.к. нижней панели нет
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
  els.connText.textContent = connected
    ? 'В сети'
    : 'Нет соединения';
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
  const el = els.roomViewScreen;
  if (el) {
    el.classList.remove('hidden');
    el.style.display = 'flex';
  }
  const nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = 'none';
  hideLoading();
}

function hideRoomView() {
  const el = els.roomViewScreen;
  if (el) {
    el.classList.add('hidden');
    el.style.display = 'none';
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
  if (state.loadingSafetyTimer) {
    clearTimeout(state.loadingSafetyTimer);
    state.loadingSafetyTimer = null;
  }
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

function handleAutoplayBlocked(sourceName) {
  console.warn(`[Autoplay] Блокировка автовоспроизведения: ${sourceName}`);
  showSnack(`🔇 Нажмите «Play», чтобы начать (${sourceName})`);
}

function updatePeersCount() {
  if (els.peersCount) {
    els.peersCount.textContent = Math.max(1, state.viewers);
  }
}

function updateHostUI() {
  // Показываем/скрываем кнопку «Сменить видео» в зависимости от роли
  if (els.changeMediaBtn) {
    els.changeMediaBtn.style.display = state.isHost ? '' : 'none';
  }
  // Обновляем подпись в панели
  const hostLabel = document.getElementById('hostLabel');
  if (hostLabel) {
    hostLabel.textContent = state.isHost ? '👑 Вы хост' : '👤 Вы гость';
  }
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
  const emptyEl = document.getElementById('roomsEmpty');
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

  // Перепривязываем обработчики на новые кнопки
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

/* ═══════════════════════════════════════════════════════════
   14. ЧАТ
   ═══════════════════════════════════════════════════════════ */

function checkChatEmpty() {
  if (els.chatEmpty) {
    els.chatEmpty.classList.toggle('hidden', state.messages.length > 0);
  }
}

function addChatMessage(msg, mine = false) {
  if (!msg || !msg.text) return;

  console.log('[Chat] addChatMessage', msg.id, msg.time, msg.replyToId, msg.replyToText, msg.replyToSender);

  // Дедупликация: не добавляем сообщение, если оно уже есть
  if (msg.id && state.messages.some(m => m.id === msg.id)) {
    return;
  }

  state.messages.push(msg);
  checkChatEmpty();
  if (els.chatEmpty) els.chatEmpty.classList.add('hidden');

  const isMine = mine || (state.socket && msg.socketId === state.socket.id);

  const el = document.createElement('div');
  el.className = 'message-bubble ' + (isMine ? 'outgoing' : 'incoming');
  el.dataset.messageId = msg.id || '';

  const time = formatTime(msg.time);
  const sender = escapeHtml(msg.sender || 'Гость');

  // Цитата (reply) — FIX 3: как в Telegram
  let replyHtml = '';
  if (msg.replyToId && msg.replyToText) {
    replyHtml = `
      <div class="reply-quote">
        <span class="reply-author">${escapeHtml(msg.replyToSender || 'Гость')}</span>
        <span class="reply-text">${escapeHtml(msg.replyToText.slice(0, 50))}</span>
      </div>
    `;
  }

  // Реакции
  let reactionsHtml = '';
  if (state.reactions[msg.id] && Object.keys(state.reactions[msg.id]).length > 0) {
    reactionsHtml = '<div class="message-reactions-container">';
    for (const [emoji, users] of Object.entries(state.reactions[msg.id])) {
      if (users.length > 0) {
        reactionsHtml += `<span class="reaction-item">${emoji} <span class="reaction-count">${users.length}</span></span>`;
      }
    }
    reactionsHtml += '</div>';
  }

  el.innerHTML = `
    <span class="message-sender">${isMine ? 'Вы' : sender}</span>
    ${replyHtml}
    <span class="message-text">${escapeHtml(msg.text)}</span>
    <span class="message-time">${time}</span>
    ${reactionsHtml}
  `;

  // Добавляем обработчики свайпа и долгого нажатия
  bindMessageInteractions(el, msg);

  els.chatMessages.appendChild(el);
  scrollChatToBottom();
}

function bindMessageInteractions(el, msg) {
  let startX = 0;
  let currentX = 0;
  let isDragging = false;
  let longPressTimer = null;
  let longPressTriggered = false;
  const SWIPE_THRESHOLD = 50;
  const LONG_PRESS_MS = 400;
  const MOVE_CANCEL_THRESHOLD = 10;

  // FIX 2: Единый обработчик touchstart — конфликт Long Press vs Swipe
  el.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    startX = touch.clientX;
    currentX = startX;
    isDragging = true;
    longPressTriggered = false;
    el.style.transition = 'none';

    // Запускаем таймер Long Press (400мс)
    longPressTimer = setTimeout(() => {
      // Если палец не двигался — это Long Press → реакции
      if (isDragging && !longPressTriggered) {
        longPressTriggered = true;
        // Вибрация
        if (window.Telegram?.WebApp?.HapticFeedback) {
          window.Telegram.WebApp.HapticFeedback.impactOccurred('light');
        }
        // Блокируем свайп
        isDragging = false;
        el.style.transform = 'translateX(0)';
        showReactionPicker(el, msg, e);
      }
    }, LONG_PRESS_MS);
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    currentX = e.touches[0].clientX;
    const diffX = currentX - startX;

    // Если палец сместился больше чем на 10px — отменяем Long Press (это свайп)
    if (Math.abs(diffX) > MOVE_CANCEL_THRESHOLD) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }

    // FIX: Направление свайпа зависит от типа сообщения
    // Входящее (.incoming) — свайп вправо; Исходящее (.outgoing) — свайп влево
    const isOutgoing = el.classList.contains('outgoing');
    const swipeDir = isOutgoing ? -1 : 1;
    const swipeAmount = diffX * swipeDir;

    if (swipeAmount > 0 && swipeAmount < 150) {
      el.style.transform = isOutgoing
        ? `translateX(-${swipeAmount}px)`
        : `translateX(${swipeAmount}px)`;

      if (swipeAmount > SWIPE_THRESHOLD && window.Telegram?.WebApp?.HapticFeedback) {
        window.Telegram.WebApp.HapticFeedback.impactOccurred('light');
      }
    }
  }, { passive: true });

  el.addEventListener('touchend', () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;

    if (!isDragging) return;
    isDragging = false;
    el.style.transition = 'transform 0.2s ease';

    const diffX = currentX - startX;
    const isOutgoing = el.classList.contains('outgoing');

    // FIX: Входящее — свайп вправо; Исходящее — свайп влево
    const shouldReply = isOutgoing ? (diffX < -SWIPE_THRESHOLD) : (diffX > SWIPE_THRESHOLD);

    if (shouldReply) {
      el.style.transform = 'translateX(0)';
      showReplyPreview(msg);
    } else {
      el.style.transform = 'translateX(0)';
    }
  });

  el.addEventListener('touchcancel', () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    isDragging = false;
    el.style.transition = 'transform 0.2s ease';
    el.style.transform = 'translateX(0)';
  });

  // Mouse events for desktop testing
  el.addEventListener('dblclick', (e) => {
    showReactionPicker(el, msg, e);
  });

  el.addEventListener('mousedown', (e) => {
    if (e.button === 0) { // Left click
      longPressTimer = setTimeout(() => {
        showReactionPicker(el, msg, e);
      }, LONG_PRESS_MS);
    }
  });

  el.addEventListener('mouseup', () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  });

  el.addEventListener('mouseleave', () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  });
}

function showReplyPreview(msg) {
  state.replyTo = {
    id: msg.id,
    sender: msg.sender || 'Гость',
    text: msg.text
  };

  const replyPreview = document.getElementById('reply-preview');
  const replyUser = document.getElementById('reply-user');
  const replyText = document.getElementById('reply-text');

  if (replyPreview && replyUser && replyText) {
    replyUser.textContent = state.replyTo.sender;
    replyText.textContent = state.replyTo.text.slice(0, 50);
    replyPreview.style.display = 'flex';
    els.chatInput.focus();
  }
}

function cancelReply() {
  state.replyTo = null;
  const replyPreview = document.getElementById('reply-preview');
  if (replyPreview) {
    replyPreview.style.display = 'none';
  }
}

function showReactionPicker(el, msg, event) {
  // Remove existing pickers
  document.querySelectorAll('.reaction-picker').forEach(p => p.remove());

  const picker = document.createElement('div');
  picker.className = 'reaction-picker visible';

  // FIX 4: Полный массив реакций
  const ALL_REACTIONS = ['❤️', '💖', '💗', '💕', '🥰', '😍', '😘', '😻', '😸', '😽', '🐾', '🎀', '🌸', '✨', '🥺', '😂', '🔥', '👍', '👎', '😮', '😢', '💩', '🤡', '👏', '🙏'];
  const recent = state.recentReactions || [];
  const uniqueOthers = ALL_REACTIONS.filter(r => !recent.includes(r));
  const orderedEmojis = [...recent, ...uniqueOthers];

  // Показываем только первые 5 + кнопка разворачивания
  const visibleEmojis = orderedEmojis.slice(0, 5);

  visibleEmojis.forEach(emoji => {
    const btn = document.createElement('button');
    btn.className = 'reaction-btn';
    btn.textContent = emoji;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      sendReaction(msg.id, emoji);
      picker.remove();
    });
    picker.appendChild(btn);
  });

  // Expand button — при клике разворачиваем панель и показываем все реакции
  const expandBtn = document.createElement('button');
  expandBtn.className = 'expand-reactions-btn';
  expandBtn.textContent = '❯';
  expandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    picker.classList.toggle('expanded');

    // Если развернули — добавляем остальные реакции
    if (picker.classList.contains('expanded')) {
      const existingEmojis = new Set(visibleEmojis);
      orderedEmojis.slice(5).forEach(emoji => {
        if (!existingEmojis.has(emoji)) {
          const btn = document.createElement('button');
          btn.className = 'reaction-btn';
          btn.textContent = emoji;
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            sendReaction(msg.id, emoji);
            picker.remove();
          });
          picker.insertBefore(btn, expandBtn);
          existingEmojis.add(emoji);
        }
      });
    }
  });
  picker.appendChild(expandBtn);

  // FIX: Динамическое позиционирование через getBoundingClientRect
  // Создаём панель в document.body, чтобы избежать обрезания экраном
  document.body.appendChild(picker);

  const rect = el.getBoundingClientRect();
  const isOutgoing = el.classList.contains('outgoing');
  const pickerHeight = 40; // примерная высота панели

  // Горизонтальное позиционирование
  if (isOutgoing) {
    // Исходящее — прижимаем к правому краю баббла
    picker.style.left = 'auto';
    picker.style.right = (window.innerWidth - rect.right) + 'px';
  } else {
    // Входящее — прижимаем к левому краю баббла
    picker.style.left = rect.left + 'px';
    picker.style.right = 'auto';
  }

  // Вертикальное позиционирование: сначала сверху
  let top = rect.top - pickerHeight - 8;
  if (top < 10) {
    // Если места сверху мало — открываем снизу
    top = rect.bottom + 8;
  }
  picker.style.top = top + 'px';

  // Закрытие при клике в любую область
  const closePicker = (e) => {
    if (!picker.contains(e.target)) {
      picker.remove();
      document.removeEventListener('click', closePicker);
      els.chatMessages.removeEventListener('scroll', closePicker);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', closePicker);
    els.chatMessages.addEventListener('scroll', closePicker);
  }, 100);
}

function sendReaction(messageId, emoji) {
  if (!state.socket || !state.connected) {
    showSnack('⚠️ Нет соединения с сервером');
    return;
  }

  // Update recent reactions
  state.recentReactions = state.recentReactions.filter(r => r !== emoji);
  state.recentReactions.unshift(emoji);
  state.recentReactions = state.recentReactions.slice(0, 8);
  localStorage.setItem('recent_reactions', JSON.stringify(state.recentReactions));

  // Send to server
  state.socket.emit('send-message-reaction', {
    messageId,
    emoji,
    sender: state.userName
  });

  // Optimistically update local state
  if (!state.reactions[messageId]) {
    state.reactions[messageId] = {};
  }
  if (!state.reactions[messageId][emoji]) {
    state.reactions[messageId][emoji] = [];
  }
  if (!state.reactions[messageId][emoji].includes(state.socket.id)) {
    state.reactions[messageId][emoji].push(state.socket.id);
  }

  // Re-render the message
  renderMessageReactions(messageId);
}

function renderMessageReactions(messageId) {
  const msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!msgEl) return;

  // Remove existing reactions container
  const existingReactions = msgEl.querySelector('.message-reactions-container');
  if (existingReactions) {
    existingReactions.remove();
  }

  // Add updated reactions
  if (state.reactions[messageId] && Object.keys(state.reactions[messageId]).length > 0) {
    const reactionsContainer = document.createElement('div');
    reactionsContainer.className = 'message-reactions-container';
    
    for (const [emoji, users] of Object.entries(state.reactions[messageId])) {
      if (users.length > 0) {
        reactionsContainer.innerHTML += `<span class="reaction-item">${emoji} <span class="reaction-count">${users.length}</span></span>`;
      }
    }
    
    const timeEl = msgEl.querySelector('.message-time');
    if (timeEl) {
      timeEl.insertAdjacentElement('afterend', reactionsContainer);
    }
  }
}

// FIX 1: Обновление DOM конкретного сообщения при получении реакции
function updateMessageReactionDOM(messageId, emoji, userId) {
  renderMessageReactions(messageId);
}

function scrollChatToBottom() {
  requestAnimationFrame(() => {
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  });
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

function sendMessage() {
  const input = document.getElementById('chat-input') || els.chatInput;
  if (!input) return;

  const text = input.value.trim();
  // Проверяем наличие валидной комнаты перед отправкой сокета
  if (!text || !window.currentRoomId) {
    console.warn('Отмена отправки: нет текста или currentRoomId = null');
    return;
  }

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

  try {
    console.log('[Chat] Отправка:', text);
    state.socket.emit('send-message', payload);
  } catch (err) {
    console.error('[Chat] Ошибка при отправке сообщения:', err);
  }

  input.value = '';
  input.focus();
}

function sendChatMessage() {
  sendMessage();
}

/* ═══════════════════════════════════════════════════════════
   15. БОКОВАЯ ПАНЕЛЬ «СМЕНИТЬ ВИДЕО»
   ═══════════════════════════════════════════════════════════ */

function openDrawer() {
  els.mediaDrawer.classList.add('open');
  els.drawerOverlay.classList.remove('hidden');
  setTimeout(() => els.urlInput.focus(), 300);
}

function closeDrawer() {
  els.mediaDrawer.classList.remove('open');
  els.drawerOverlay.classList.add('hidden');
}

/* ═══════════════════════════════════════════════════════════
   16. ИНВИТ / КОПИРОВАНИЕ ССЫЛКИ
   ═══════════════════════════════════════════════════════════ */

async function inviteFriend() {
  const inviteUrl = makeInviteUrl();

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(inviteUrl);
    } else {
      Telegram.WebApp.Clipboard?.writeText(inviteUrl);
    }
    showSnack('🔗 Ссылка-приглашение скопирована');
  } catch (e) {
    console.warn('[Invite] Clipboard недоступен:', e);
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

/* ═══════════════════════════════════════════════════════════
   17. УТИЛИТЫ БЕЗОПАСНОСТИ / ФОРМАТИРОВАНИЯ
   ═══════════════════════════════════════════════════════════ */

function escapeHtml(str) {
  const ESCAPE_MAP = {
    '&': String.fromCharCode(38) + 'amp;',
    '<': String.fromCharCode(38) + 'lt;',
    '>': String.fromCharCode(38) + 'gt;',
    '"': String.fromCharCode(38) + 'quot;',
    "'": String.fromCharCode(38) + '#39;',
  };

  return String(str).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/* ═══════════════════════════════════════════════════════════
   18. ОБРАБОТКА UI-СОБЫТИЙ
   ═══════════════════════════════════════════════════════════ */

function joinRoomByCode() {
  const code = els.joinCodeInput.value.trim();
  if (!code) {
    showSnack('🔑 Введите код комнаты');
    return;
  }

  // Разрешаем ввод как с префиксом r_, так и без него
  let roomId = code;
  if (!roomId.startsWith('r_')) {
    roomId = 'r_' + roomId;
  }

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(roomId)) {
    showSnack('❌ Некорректный код комнаты');
    return;
  }

  // Переключаем комнату: переподключаемся с новым room_id
  state.roomId = roomId;
  window.currentRoomId = roomId;
  els.roomBadge.textContent = state.roomId;
  els.roomBadge.title = 'Комната: ' + state.roomId;
  els.myRoomCode.textContent = state.roomId;

  // Переподключаемся к серверу с новой комнатой
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

function bindUI() {
  // ── Вход по ID комнаты ────────────────────────────────────
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

  // ── Обновление списка комнат ────────────────────────────────
  const refreshRoomsBtn = document.getElementById('refreshRoomsBtn');
  if (refreshRoomsBtn) {
    refreshRoomsBtn.addEventListener('click', () => {
      if (state.socket && state.connected) {
        state.socket.emit('get-rooms');
      }
    });
  }

  // ── Нижнее меню навигации (Bottom Navigation) ─────────────
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      const tabId = item.dataset.tab;
      if (!tabId) return;

      // Скрываем экран комнаты при переключении вкладок
      hideRoomView();

      // Переключаем активный класс
      document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
      item.classList.add('active');

      // Показываем/скрываем вкладки
      document.querySelectorAll('.tab-content').forEach((tab) => {
        tab.style.display = tab.id === tabId ? 'flex' : 'none';
      });

      if (tabId === 'rooms-tab' && state.socket && state.connected) {
        state.socket.emit('get-rooms');
      }

      // Haptic feedback при смене вкладки
      if (window.Telegram?.WebApp?.HapticFeedback) {
        window.Telegram.WebApp.HapticFeedback.selectionChanged();
      }
    });
  });

  // Кнопка «Создать комнату»
  const createRoomBtn = document.getElementById('createRoomBtn');
  if (createRoomBtn) {
    createRoomBtn.addEventListener('click', () => {
      const url = (document.getElementById('createRoomUrl')?.value || '').trim();

      // НЕ переподключаемся с query room — создаём комнату на текущем сокете.
      // Это чинит баг, когда socket висел в двух комнатах и комната не появлялась в списке.
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

        // Принудительно обновляем список комнат, чтобы новая комната появилась
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

  // Вход в комнату из списка
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

  // Открыть панель смены видео
  els.changeMediaBtn.addEventListener('click', openDrawer);
  els.drawerCloseBtn.addEventListener('click', closeDrawer);
  els.drawerOverlay.addEventListener('click', closeDrawer);

  // Отмена ответа
  const cancelReplyBtn = document.getElementById('cancel-reply');
  if (cancelReplyBtn) {
    cancelReplyBtn.addEventListener('click', cancelReply);
  }

  // Подключение по коду
  els.joinCodeBtn.addEventListener('click', joinRoomByCode);
  els.joinCodeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      joinRoomByCode();
    }
  });

  // Кнопка «Включить»
  els.loadBtn.addEventListener('click', () => {
    const url = els.urlInput.value.trim();
    if (!url) {
      showSnack('🔗 Вставьте ссылку на видео');
      els.urlInput.focus();
      return;
    }
    loadMedia(url);
  });

  // Enter в поле URL
  els.urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      els.loadBtn.click();
    }
  });

  // Пресеты источников (делегирование)
  els.presetRow.addEventListener('click', (event) => {
    const btn = event.target.closest('.preset-btn');
    if (!btn) return;
    const url = btn.dataset.url;
    if (url) loadMedia(url);
  });

  // Пригласить
  els.inviteBtn.addEventListener('click', inviteFriend);

  // Пиры — открываем панель и показываем участников
  els.peersBtn.addEventListener('click', () => {
    state.socket.emit('GET_PEERS');
    openDrawer();
  });

  // Очередь: удаление элемента
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

  // Защита от мобильного сабмита формы Enter'ом: теперь это просто div,
  // но оставляем preventDefault на случай системной отправки.
  els.chatSendBtn.addEventListener('click', sendChatMessage);
  els.chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage();
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   18.5. АНИМИРОВАННЫЕ СЕРДЕЧКИ В ЧАТЕ
   ═══════════════════════════════════════════════════════════ */

let heartsEnabled = true;

function createHeart() {
  const container = document.querySelector('.hearts-bg');
  if (!container) return;

  // Проверяем, включены ли сердечки
  const toggle = document.getElementById('heartsToggle');
  if (toggle && !toggle.checked) return;

  // Случайный пропуск: создаем сердечки только в 40% случаев
  if (Math.random() > 0.4) return;

  // Создаем 2-4 сердечка за раз
  const count = Math.floor(Math.random() * 3) + 2; // 2, 3 или 4

  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const heart = document.createElement('div');
      heart.classList.add('heart-particle');
      
      const hearts = ['💖', '💕', '💗', '❤️', '🌸'];
      heart.innerText = hearts[Math.floor(Math.random() * hearts.length)];
      
      heart.style.left = Math.random() * 90 + 5 + '%';
      heart.style.animationDuration = (Math.random() * 3 + 6) + 's'; // медленный подъем (6-9 сек)
      heart.style.fontSize = (Math.random() * 8 + 12) + 'px';

      container.appendChild(heart);

      setTimeout(() => { heart.remove(); }, 9000);
    }, i * 200); // небольшой интервал между появлением (200мс)
  }
}

// FIX 5: Запускаем проверку раз в 2.5 секунды
setInterval(createHeart, 2500);

/* ═══════════════════════════════════════════════════════════
   18. РОМАНТИЧНЫЕ ВЫЛЕТАЮЩИЕ КОМПЛИМЕНТЫ
   ═══════════════════════════════════════════════════════════ */

const COMPLIMENTS = [
  'Ксюня, ты самая лучшая! 💖',
  'Ксюня, ты самая красивая! ✨',
  'Ксюша, ты самая милая! 🌸',
  'Ксюш, ты просто невероятная! 👑',
  'Ксюша, ты солнышко! ☀️',
  'У тебя самая прекрасная улыбка на свете! 😊✨',
  'Ксюнь, ты делаешь каждый мой день ярче 🌟',
  'Ты невероятно обаятельная! 💫',
  'Ксюня, ты мое главное счастье 🍀',
  'Ксюш, спасибо, что ты у меня есть ❤️',
  'С каждым днем влюбляюсь в тебя все сильнее 💕',
  'Ты - всё самое лучшее, что со мной случалось ✨',
  'Лучший вечер - это вечер рядом с тобой 🌙',
  'Уютики с Ксюшей — 100 из 10 🧸❤️',
  'Главная достопримечательность этого вечера - ты 💖',
  'Ксюш, обнять тебя - лучшее лекарство от любой усталости 🫂',
  'Внимание! В комнате обнаружена самая красивая девчонка 🚨💖',
  'Ты - 1000/10, без вариантов! 🔥',
  'Как мне вообще так повезло с тобой? 🥺✨',
  'Ксюша, ты просто космос! 🌌',
  'Ты милее всех котиков в интернете, вместе взятых 🐾❤️',
  'Ксюня - ты настоящий лучик света 💡❤️',
  'У тебя самые красивые и добрые глаза 🥺💖',
  'Мое сердце принадлежит только тебе 🔒❤️',
  'Ты прекрасна в любой момент времени ✨',
  'Осторожно: уровень милоты Ксюши зашкаливает! ⚠️💖',
  'Официально заявляю: Ксюня - самая лучшая девочка в мире 📜❤️',
  'Если бы за милоту давали штрафы, ты бы уже была банкротом 🚓💓',
  'Мой любимый вид спорта - обнимать Ксюшу 🏆🫂',
  'Ксюня - главный админ моего сердца 👑❤️',
  'Ксюня = любовь ❤️',
  'Принцесса 👑✨',
  'Самая-самая! 💖',
  'Обожаю тебя! 💕',
  'Люблю безумно! 🔥💖',
  'Ты чудесная! 🌸',
  'Целую! 💋',
  'Звезда ⭐️',
  'Люблю люблю люблю! ❤️❤️❤️',
  'Рядом с тобой даже самый пасмурный день становится теплым ☀️❤️',
  'Ты - мой самый любимый повод для улыбки 💓',
  'Ксюнь, ты - абсолютное совершенство 💯👑',
  'Кажется, ты украла мое сердце, но я совсем не против 😉🔒',
  'Ксюнь, ты слаще любого десерта 🧁💖',
  'Встретить тебя - это как выбить суперприз в жизни 🍀✨',
  'Если бы существовал конкурс на самую милую девушку, ты бы забрала все призы 🏆🌸',
  'Ксюнь, ты просто нереальная! 💫😍',
  'Ты не просто прекрасна, ты уникальна 👑💓',
  'Люблю тебя до Луны и обратно! 🌌❤️',
];

function spawnCompliment() {
  const container = document.getElementById('room-view-screen') || document.body;
  if (!container) return;

  const msg = document.createElement('div');
  msg.className = 'floating-compliment';

  const randomText = COMPLIMENTS[Math.floor(Math.random() * COMPLIMENTS.length)];
  msg.innerText = randomText;

  const randomOffset = (Math.random() - 0.5) * 80;
  msg.style.transform = `translateX(calc(-50% + ${randomOffset}px))`;

  container.appendChild(msg);

  setTimeout(() => {
    msg.remove();
  }, 5200);
}

// Таймер: раз в 8 минут
setInterval(spawnCompliment, 480000);

/* ═══════════════════════════════════════════════════════════
    19. ИНИЦИАЛИЗАЦИЯ
    ═══════════════════════════════════════════════════════════ */

(function init() {
  console.log('%c RAVE TMA — синхронный просмотр в стиле Rave ', 'background:#5288c1;color:#fff;font-size:14px;padding:6px;border-radius:4px');

  // Telegram SDK
  initTelegram();

  // Отображаем комнату в бейдже
  els.roomBadge.textContent = state.roomId;
  els.roomBadge.title = 'Комната: ' + state.roomId;
  if (els.myRoomCode) els.myRoomCode.textContent = state.roomId;

  // Привязка UI
  bindUI();

  // Локальные события HTML5-плеера
  bindNativeVideoEvents();

  // Подключаемся к Socket.io
  connectSocket();

  // Если открылись по Telegram deep link — сразу подключаемся к комнате
  const startParam = (window.Telegram?.WebApp?.initDataUnsafe || {}).start_param;
  if (startParam) {
    setTimeout(() => {
      state.roomId = startParam;
      window.currentRoomId = startParam;
      els.roomBadge.textContent = state.roomId;
      els.roomBadge.title = 'Комната: ' + state.roomId;
      if (els.myRoomCode) els.myRoomCode.textContent = state.roomId;
      connectSocket();
      showRoomView();
    }, 500);
  }

  // Статус
  renderDrawerPeers();
  updatePeersCount();

  // Автозапуск по URL ?media=... (удобно для прямых ссылок из чата)
  const mediaParam = new URLSearchParams(window.location.search).get('media');
  if (mediaParam) {
    setTimeout(() => loadMedia(mediaParam), 500);
  }
})();