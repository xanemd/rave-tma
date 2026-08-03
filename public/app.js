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

/* ═══════════════════════════════════════════════════════════
   0. КОНСТАНТЫ И СОСТОЯНИЕ
   ═══════════════════════════════════════════════════════════ */

const SYNC_THRESHOLD_SECONDS = 0.5;

const SOURCE_TYPES = {
  YOUTUBE: 'youtube',
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
  pendingYouTubeVideoId: null,

  applyingRemote: false,

  peers: [],

  userName: 'Гость',
  userId: null,

  // Чат
  messages: [],
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
  quickList: $('#quickList'),
  joinCodeInput: $('#joinCodeInput'),
  joinCodeBtn: $('#joinCodeBtn'),
  myRoomCode: $('#myRoomCode'),

  // Индикатор загрузки
  loadingOverlay: $('#loadingOverlay'),
  loadingText: $('#loadingText'),
};

let snackbarEl = null;
let snackbarTimer = null;

/* ═══════════════════════════════════════════════════════════
   2. ИНИЦИАЛИЗАЦИЯ TELEGRAM WEBAPP SDK
   ═══════════════════════════════════════════════════════════ */

function initTelegram() {
  if (!window.Telegram || !window.Telegram.WebApp) {
    console.warn('Telegram WebApp SDK недоступен — работаем в обычном браузере.');
    if (!state.roomId) state.roomId = generateRoomId();
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
  } else if (!state.roomId) {
    state.roomId = generateRoomId();
  }

  console.log('[Telegram] initData →', {
    room: state.roomId,
    user: state.userName,
  });

  tg.onEvent('viewportChanged', () => {
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
    yt: els.ytHost,
    video: els.videoHost,
    iframe: els.iframeHost,
  };

  Object.entries(shells).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== shellId);
  });

  els.placeholder.classList.toggle('hidden', shellId !== null);
}

function resetPlayers(keepVisible = false) {
  state.applyingRemote = true;

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
  els.ytHost.innerHTML = '';

  try { els.embedFrame.src = 'about:blank'; } catch (e) { /* ignore */ }

  state.applyingRemote = false;
  state.currentUrl = '';

  if (!keepVisible) {
    showOnlyShell(null);
  }
}

/* ═══════════════════════════════════════════════════════════
   5. YouTube ПЛЕЕР
   ═══════════════════════════════════════════════════════════ */

window.onYouTubeIframeAPIReady = function () {
  console.log('[YouTube] IFrame API готов');
  state.ytReady = true;
  hideLoading();

  if (state.pendingYouTubeVideoId) {
    loadYouTubeVideo(state.pendingYouTubeVideoId);
    state.pendingYouTubeVideoId = null;
  }
};

setTimeout(() => {
  if (!state.ytReady) {
    console.error('[YouTube] API не загрузился за 10 секунд');
    setStatus('⚠️ YouTube API не загрузился. Проверьте соединение.');
    showSnack('❌ Не удалось загрузить YouTube API');
    hideLoading();
  }
}, 10000);

function loadYouTubeVideo(videoId, autoplay = true) {
  const host = els.ytHost;
  host.classList.remove('hidden');
  showOnlyShell('yt');

  if (!state.ytReady) {
    state.pendingYouTubeVideoId = videoId;
    setStatus('⏳ YouTube API загружается…');
    return;
  }

  if (!state.ytPlayer) {
    host.innerHTML = `
      <div id="ytPlayer" class="youtube-player"
           style="width:100%;height:100%;"></div>
    `;

    state.ytPlayer = new YT.Player('ytPlayer', {
      videoId,
      playerVars: {
        autoplay: autoplay ? 1 : 0,
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        origin: window.location.origin,
      },
      events: {
        onReady: (event) => {
          console.log('[YouTube] Плеер готов');
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
          hideLoading();
        },
      },
    });
  } else {
    state.ytPlayer.loadVideoById(videoId, 0, autoplay ? 'large' : 'default');
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
              break;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.addEventListener('loadedmetadata', () => {
        hideLoading();
        setStatus('📡 HLS поток готов (нативно)');
        if (autoplay) video.play().catch(() => handleAutoplayBlocked('HLS'));
      }, { once: true });
    } else {
      console.error('[HLS] HLS.js недоступен');
      setStatus('⚠️ HLS не поддерживается на этом устройстве');
      hideLoading();
    }
  } else {
    video.src = url;
    video.load();
    if (autoplay) {
      video.play().catch(() => handleAutoplayBlocked('видео'));
    }
  }

  video.addEventListener('loadedmetadata', () => {
    hideLoading();
  }, { once: true });
}

/* ═══════════════════════════════════════════════════════════
   7. IFRAME ПЛЕЕР (VK Video и др.)
   ═══════════════════════════════════════════════════════════ */

function loadIframe(embedUrl) {
  showOnlyShell('iframe');
  els.embedFrame.src = embedUrl;
  setTimeout(hideLoading, 1500);
  setStatus('🖥 Встроенный плеер');
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

  state.currentUrl = rawUrl.trim();
  state.currentType = parsed.type;

  resetPlayers(true);
  showLoading('Загрузка видео…');

  switch (parsed.type) {
    case SOURCE_TYPES.YOUTUBE:
      loadYouTubeVideo(parsed.payload.videoId, autoplay);
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

/* ═══════════════════════════════════════════════════════════
   9. SOCKET.IO — ПОДКЛЮЧЕНИЕ И ОБРАБОТКА СОБЫТИЙ
   ═══════════════════════════════════════════════════════════ */

function connectSocket() {
  const socketUrl = window.location.origin;

  state.socket = io(socketUrl, {
    transports: ['websocket', 'polling'],
    query: { room: state.roomId },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  const s = state.socket;

  s.on('connect', () => {
    state.connected = true;
    updateConnUI(true);
    console.log('[Socket] Подключено →', socketUrl, '| room:', state.roomId);
    setStatus('🟢 Подключено к комнате');
    showSnack('🟢 Подключено к комнате');
  });

  s.on('disconnect', (reason) => {
    state.connected = false;
    updateConnUI(false);
    console.warn('[Socket] Отключено:', reason);
    setStatus('🔴 Нет соединения с сервером');
  });

  s.on('connect_error', (err) => {
    console.error('[Socket] Ошибка подключения:', err.message);
    setStatus('🔴 Ошибка подключения');
  });

  s.on('hello', (data) => {
    console.log('[Socket] hello →', data);
  });

  // ── Запрос состояния от нового участника ─────────────────
  s.on('request_state', ({ from }) => {
    console.log('[Socket] Запрос состояния от', from);

    if (state.currentUrl && state.currentType !== SOURCE_TYPES.UNKNOWN) {
      const time = getCurrentPlayhead();
      s.emit('CHANGE_MEDIA', {
        mediaType: state.currentType,
        url: state.currentUrl,
        time,
        autoplay: true,
        forPeer: from,
      });
      setTimeout(() => {
        s.emit('SEEK', {
          mediaType: state.currentType,
          url: state.currentUrl,
          time,
        });
      }, 300);
    }
  });

  // ── Ивенты синхронизации ─────────────────────────────────
  s.on('PLAY', (data) => {
    console.log('[Sync] PLAY ←', data);
    handleRemotePlay(data);
  });

  s.on('PAUSE', (data) => {
    console.log('[Sync] PAUSE ←', data);
    handleRemotePause(data);
  });

  s.on('SEEK', (data) => {
    console.log('[Sync] SEEK ←', data);
    handleRemoteSeek(data);
  });

  s.on('CHANGE_MEDIA', (data) => {
    console.log('[Sync] CHANGE_MEDIA ←', data);
    handleRemoteMedia(data);
  });

  s.on('USER_LEFT', ({ id }) => {
    console.log('[Sync] USER_LEFT ←', id);
    state.peers = state.peers.filter((p) => p.id !== id);
    updatePeersCount();
    renderDrawerPeers();
    showSnack('👋 Участник покинул комнату');
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
    addChatMessage(data, false);
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
}

function emitIfNeeded(eventName, payload) {
  if (state.applyingRemote) {
    console.log('[Emit] Пропуск (applyingRemote)', eventName);
    return;
  }
  state.socket.emit(eventName, {
    ...payload,
    sender: state.userName || state.socket.id,
  });
}

/* ═══════════════════════════════════════════════════════════
   10. ОБРАБОТЧИКИ REMOTE-КОМАНД
   ═══════════════════════════════════════════════════════════ */

function withRemoteFlag(fn) {
  state.applyingRemote = true;
  try {
    fn();
  } finally {
    setTimeout(() => {
      state.applyingRemote = false;
    }, 50);
  }
}

function handleRemotePlay(data) {
  const type = data.mediaType || state.currentType;

  if (data.url && data.url !== state.currentUrl) {
    handleRemoteMedia({ ...data, autoplay: false });
  }

  withRemoteFlag(() => {
    switch (type) {
      case SOURCE_TYPES.YOUTUBE:
        if (state.ytPlayer && typeof state.ytPlayer.playVideo === 'function') {
          try { state.ytPlayer.playVideo(); } catch (e) { /* ignore */ }
          if (typeof data.time === 'number' && data.time > 0) {
            syncYouTubeTime(data.time);
          }
        }
        break;

      case SOURCE_TYPES.NATIVE:
      case SOURCE_TYPES.HLS: {
        const desired = data.time || 0;
        const current = els.nativeVideo.currentTime || 0;

        // Если видео ещё не загружено — запомним время до loadedmetadata
        if (els.nativeVideo.readyState < 2 && desired > 0) {
          els.nativeVideo.addEventListener('loadedmetadata', () => {
            try { els.nativeVideo.currentTime = desired; } catch (e) { /* ignore */ }
          }, { once: true });
        } else if (Math.abs(desired - current) > SYNC_THRESHOLD_SECONDS && desired > 0) {
          els.nativeVideo.currentTime = desired;
        }

        els.nativeVideo.play().catch(() => handleAutoplayBlocked('видео'));
        break;
      }

      case SOURCE_TYPES.IFRAME:
        console.warn('[Sync] PLAY для iframe — синхронизация времени невозможна');
        break;
    }
  });
  setStatus('▶ Воспроизведение (от партнёра)');
}

function handleRemotePause(data) {
  const type = data.mediaType || state.currentType;

  if (data.url && data.url !== state.currentUrl) {
    handleRemoteMedia({ ...data, autoplay: false });
  }

  withRemoteFlag(() => {
    switch (type) {
      case SOURCE_TYPES.YOUTUBE:
        if (state.ytPlayer && typeof state.ytPlayer.pauseVideo === 'function') {
          try { state.ytPlayer.pauseVideo(); } catch (e) { /* ignore */ }
        }
        break;

      case SOURCE_TYPES.NATIVE:
      case SOURCE_TYPES.HLS:
        els.nativeVideo.pause();
        break;

      case SOURCE_TYPES.IFRAME:
        console.warn('[Sync] PAUSE для iframe — невозможно');
        break;
    }
  });
  setStatus('⏸ Пауза (от партнёра)');
}

function handleRemoteSeek(data) {
  const type = data.mediaType || state.currentType;
  const seekTo = typeof data.time === 'number' ? data.time : 0;

  if (data.url && data.url !== state.currentUrl) {
    handleRemoteMedia({ ...data, autoplay: false });
  }

  withRemoteFlag(() => {
    switch (type) {
      case SOURCE_TYPES.YOUTUBE:
        if (state.ytPlayer && typeof state.ytPlayer.seekTo === 'function') {
          try { state.ytPlayer.seekTo(seekTo, true); } catch (e) { /* ignore */ }
        }
        break;

      case SOURCE_TYPES.NATIVE:
      case SOURCE_TYPES.HLS: {
        const video = els.nativeVideo;
        if (video.readyState < 2) {
          video.addEventListener('loadedmetadata', () => {
            try { video.currentTime = seekTo; } catch (e) { /* ignore */ }
          }, { once: true });
        } else {
          try { video.currentTime = seekTo; } catch (e) { /* ignore */ }
        }
        break;
      }

      case SOURCE_TYPES.IFRAME:
        console.warn('[Sync] SEEK для iframe — невозможно');
        break;
    }
  });
  setStatus('⏩ Перемотка (от партнёра)');
}

function handleRemoteMedia(data) {
  const { url, mediaType, time, autoplay = true } = data;

  if (!url || url === state.currentUrl) {
    if (typeof time === 'number' && time > 0) {
      handleRemoteSeek({ ...data, mediaType: mediaType || state.currentType, time });
    }
    return;
  }

  console.log('[Sync] Загружаем удалённое медиа:', mediaType, url);

  loadMedia(url, {
    emit: false,
    autoplay: autoplay,
    incoming: true,
  });

  // Повторяем попытки запуска, пока плеер не будет готов.
  // Это решает проблему, когда CHANGE_MEDIA приходит раньше,
  // чем плеер успел инициализироваться (особенно YouTube).
  let attempts = 0;
  const maxAttempts = 10;
  const retryInterval = setInterval(() => {
    attempts++;
    const ready = isPlayerReady(mediaType || state.currentType);

    if (ready) {
      clearInterval(retryInterval);
      // Всегда применяем seek, если время > 0
      if (typeof time === 'number' && time > 0) {
        handleRemoteSeek({ ...data, mediaType: mediaType || state.currentType, time });
      }
      // Всегда запускаем, если autoplay (даже при time === 0)
      if (autoplay) {
        handleRemotePlay({ ...data, mediaType: mediaType || state.currentType, time });
      }
    } else if (attempts >= maxAttempts) {
      clearInterval(retryInterval);
      console.warn('[Sync] Плеер не стал готов за ' + maxAttempts + ' попыток');
    }
  }, 500);
}

/**
 * Проверяет, готов ли плеер для данного типа медиа.
 */
function isPlayerReady(type) {
  switch (type) {
    case SOURCE_TYPES.YOUTUBE:
      return !!(state.ytPlayer && typeof state.ytPlayer.playVideo === 'function');
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
  switch (state.currentType) {
    case SOURCE_TYPES.YOUTUBE:
      return getYouTubeCurrentTime();
    case SOURCE_TYPES.NATIVE:
    case SOURCE_TYPES.HLS: {
      const v = els.nativeVideo;
      return v && typeof v.currentTime === 'number' ? v.currentTime : 0;
    }
    default:
      return 0;
  }
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

let syncInterval = null;

function startSyncLoop() {
  if (syncInterval) clearInterval(syncInterval);

  syncInterval = setInterval(() => {
    if (!state.socket || !state.connected) return;
    if (state.applyingRemote) return;

    const type = state.currentType;
    if (type !== SOURCE_TYPES.YOUTUBE && type !== SOURCE_TYPES.NATIVE && type !== SOURCE_TYPES.HLS) {
      return;
    }

    const time = getCurrentPlayhead();
    if (time <= 0) return;

    emitIfNeeded('SEEK', {
      mediaType: type,
      url: state.currentUrl,
      time,
    });
  }, 5000);
}

function stopSyncLoop() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

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
    startSyncLoop();
  });

  video.addEventListener('pause', () => {
    if (state.applyingRemote) return;
    emitIfNeeded('PAUSE', {
      mediaType: SOURCE_TYPES.NATIVE,
      url: state.currentUrl,
      time: video.currentTime,
    });
    stopSyncLoop();
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
  });
}

/* ═══════════════════════════════════════════════════════════
   13. UI-ХЕЛПЕРЫ
   ═══════════════════════════════════════════════════════════ */

// Статус теперь выводится в snackbar, т.к. нижней панели нет
function setStatus(text) {
  console.log('[Status]', text);
}

function updateConnUI(connected) {
  els.connStatus.classList.toggle('connected', connected);
  els.connStatus.classList.toggle('disconnected', !connected);
  els.connText.textContent = connected
    ? 'В сети'
    : 'Нет соединения';
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
    els.peersCount.textContent = state.peers.length + 1;
  }
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

  state.messages.push(msg);
  checkChatEmpty();
  if (els.chatEmpty) els.chatEmpty.classList.add('hidden');

  const isMine = mine || (state.socket && msg.socketId === state.socket.id);

  const el = document.createElement('div');
  el.className = 'msg ' + (isMine ? 'mine' : 'theirs');

  const time = formatTime(msg.time);
  const sender = escapeHtml(msg.sender || 'Гость');

  el.innerHTML = `
    <div class="msg-meta">
      <span class="msg-sender">${isMine ? 'Вы' : sender}</span>
      <span class="msg-time">${time}</span>
    </div>
    <div class="msg-text">${escapeHtml(msg.text)}</div>
  `;

  els.chatMessages.appendChild(el);
  scrollChatToBottom();
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

function sendChatMessage() {
  const text = els.chatInput.value.trim();
  if (!text) return;

  state.socket.emit('CHAT', {
    text,
    sender: state.userName,
  });

  // Оптимистично показываем своё сообщение
  addChatMessage({
    id: 'local_' + Date.now(),
    text,
    sender: state.userName,
    socketId: state.socket.id,
    time: Date.now(),
  }, true);

  els.chatInput.value = '';
  els.chatInput.focus();
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
    await navigator.clipboard.writeText(inviteUrl);
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
  els.roomBadge.textContent = state.roomId;
  els.roomBadge.title = 'Комната: ' + state.roomId;
  els.myRoomCode.textContent = state.roomId;

  // Переподключаемся к серверу с новой комнатой
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
  connectSocket();

  showSnack('🔑 Подключено к комнате: ' + roomId);
  closeDrawer();
}

function bindUI() {
  // Открыть панель смены видео
  els.changeMediaBtn.addEventListener('click', openDrawer);
  els.drawerCloseBtn.addEventListener('click', closeDrawer);
  els.drawerOverlay.addEventListener('click', closeDrawer);

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

  // Быстрый выбор
  els.quickList.addEventListener('click', (event) => {
    const btn = event.target.closest('.quick-item');
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

  // Чат
  els.chatSendBtn.addEventListener('click', sendChatMessage);
  els.chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendChatMessage();
    }
  });
}

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

  // Статус
  renderDrawerPeers();
  updatePeersCount();

  // Автозапуск по URL ?media=... (удобно для прямых ссылок из чата)
  const mediaParam = new URLSearchParams(window.location.search).get('media');
  if (mediaParam) {
    setTimeout(() => loadMedia(mediaParam), 500);
  }
})();