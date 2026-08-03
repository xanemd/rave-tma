/**
 * ─────────────────────────────────────────────────────────────
 *  RAVE TMA — клиентская логика
 *
 *  Всё синхронное поведение строится на следующих правилах:
 *
 *  1. Каждый клиент общается с сервером через Socket.io.
 *  2. События от ЛОКАЛЬНЫХ действий пользователя
 *     (play / pause / seek / смена видео) отправляются на сервер,
 *     а сервер ретранслирует их ВСЕМ остальным участникам комнаты.
 *  3. События, пришедшие ОТ СЕРВЕРА (т.е. от другого участника),
 *     применяются к локальному плееру, НО НЕ отправляются обратно
 *     (защита от петли событий / Event Loop Fix).
 *     Дополнительно локальные события плеера (onplay, onpause,
 *     seeked) блокируются флагом applyingRemote.
 *  4. Порог рассинхрона для принудительного seek — 0.5 секунды.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   0. КОНСТАНТЫ И СОСТОЯНИЕ
   ═══════════════════════════════════════════════════════════ */

const SYNC_THRESHOLD_SECONDS = 0.5; // Порог рассинхрона

const SOURCE_TYPES = {
  YOUTUBE: 'youtube',
  HLS: 'hls',
  NATIVE: 'native',       // .mp4 / .webm и др. прямые файлы
  IFRAME: 'iframe',       // VK Video / любые embed-ссылки
  UNKNOWN: 'unknown'
};

const state = {
  socket: null,
  roomId: '',
  connected: false,

  currentType: SOURCE_TYPES.UNKNOWN,
  currentUrl: '',

  // YouTube IFrame API
  ytReady: false,
  ytPlayer: null,
  pendingYouTubeVideoId: null,

  // Флаг: применяем ли мы команду от сервера (защита от петель)
  applyingRemote: false,

  // Для «peers» модалки
  peers: [],

  // Текущий пользователь (из Telegram initDataUnsafe)
  userName: 'Guest',
  userId: null,
};

/* ═══════════════════════════════════════════════════════════
   1. УТИЛИТЫ / СНИППЕТЫ DOM
   ═══════════════════════════════════════════════════════════ */

const $ = (sel) => document.querySelector(sel);

const els = {
  urlInput: $('#urlInput'),
  loadBtn: $('#loadBtn'),
  presetRow: $('#presetRow'),
  connStatus: $('#connStatus'),
  connText: $('#connText'),
  statusLabel: $('#statusLabel'),
  roomBadge: $('#roomBadge'),

  placeholder: $('#placeholder'),
  ytHost: $('#ytPlayerHost'),
  videoHost: $('#videoHost'),
  nativeVideo: $('#nativeVideo'),
  iframeHost: $('#iframeHost'),
  embedFrame: $('#embedFrame'),

  loadingOverlay: $('#loadingOverlay'),
  loadingText: $('#loadingText'),

  inviteBtn: $('#inviteBtn'),
  peersBtn: $('#peersBtn'),
  resetBtn: $('#resetBtn'),
};

let snackbarEl = null;
let modalOverlayEl = null;
let snackbarTimer = null;

/* ═══════════════════════════════════════════════════════════
   2. ИНИЦИАЛИЗАЦИЯ TELEGRAM WEBAPP SDK
   ═══════════════════════════════════════════════════════════ */

function initTelegram() {
  if (!window.Telegram || !window.Telegram.WebApp) {
    console.warn('Telegram WebApp SDK недоступен — работаем в обычном браузере.');
    // Создаём комнату и для обычного браузера (без Telegram)
    if (!state.roomId) state.roomId = generateRoomId();
    return;
  }

  const tg = window.Telegram.WebApp;

  // Раскрываем на весь экран сразу при запуске
  tg.expand();
  tg.ready();

  // Применяем тему Telegram (фон, кнопка и т.д.) через CSS-переменные.
  // SDK сам инжектит --tg-theme-* в :root, но мы дополнительно
  // вызываем setHeaderColor / setBackgroundColor для красоты.
  try {
    tg.setHeaderColor(tg.themeParams.bg_color || '#17212b');
    tg.setBackgroundColor(tg.themeParams.bg_color || '#17212b');
  } catch (e) {
    /* не критично */
  }

  // Данные пользователя из initDataUnsafe
  const initData = tg.initDataUnsafe || {};
  const user = initData.user || {};

  if (user.first_name || user.username) {
    state.userName = user.first_name || user.username || 'Guest';
    state.userId = user.id != null ? String(user.id) : null;
  }

  // room_id из Telegram: ?startapp=room_abc или из query-параметра
  // ВАЖНО: start_param приходит в initDataUnsafe.start_param
  let roomFromTelegram =
    initData.start_param ||
    new URLSearchParams(window.location.search).get('room') ||
    '';

  if (roomFromTelegram && /^[a-zA-Z0-9_-]{1,64}$/.test(roomFromTelegram)) {
    state.roomId = roomFromTelegram;
  } else if (!state.roomId) {
    // Нет комнаты — создаём новую уникальную.
    // Каждый новый пользователь получает свою комнату, а ссылка
    // ?room=... (кнопка «Пригласить») позволит другу попасть в неё.
    state.roomId = generateRoomId();
  }

  console.log('[Telegram] initData →', {
    room: state.roomId,
    user: state.userName,
  });

  // Обработчик закрытия
  tg.onEvent('viewportChanged', () => {
    // При изменении вьюпорта может потребоваться пересборка плеера
    if (state.ytPlayer && typeof state.ytPlayer.getIframe === 'function') {
      requestAnimationFrame(() => {
        try { state.ytPlayer.getIframe(); } catch (e) { /* ignore */ }
      });
    }
  });
}

/**
 * Генерирует уникальный ID комнаты вида r_xxxxxxxxxx.
 * Используется, когда пользователь открыл приложение без ссылки-приглашения.
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
    // Фолбэк, если crypto недоступен
    result += Math.random().toString(36).slice(2, 10);
  }
  return result;
}

/* ═══════════════════════════════════════════════════════════
   3. ПАРСЕР ССЫЛОК
   ═══════════════════════════════════════════════════════════ */

/**
 * Определяет тип источника по URL.
 * Возвращает { type, payload } где payload зависит от типа:
 *  - youtube: { videoId }
 *  - iframe:  { embedUrl }
 *  - native/hls: { url }
 *  - unknown: null
 */
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

  // ── 1. YouTube ─────────────────────────────────────────────
  // youtube.com/watch?v=... | youtu.be/... | youtube.com/shorts/... | m.youtube.com
  if (
    host === 'youtube.com' ||
    host === 'www.youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtu.be' ||
    host.endsWith('.youtube.com')
  ) {
    let videoId = null;

    if (host === 'youtu.be') {
      // youtu.be/VIDEO_ID
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length > 0) videoId = parts[0];
    } else {
      const v = parsed.searchParams.get('v');
      if (v) {
        videoId = v;
      } else {
        // Поддержка /shorts/VIDEO_ID
        const m = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/);
        if (m) videoId = m[1];
      }
    }

    if (videoId && /^[a-zA-Z0-9_-]{6,15}$/.test(videoId)) {
      return { type: SOURCE_TYPES.YOUTUBE, payload: { videoId } };
    }
    return { type: SOURCE_TYPES.UNKNOWN, payload: { error: 'Не удалось распознать YouTube-видео' } };
  }

  // ── 2. Прямые медиа-файлы (mp4, webm, ogg, mov) ──────────
  const directMediaExt = /\.(mp4|webm|ogg|ogv|mov|m4v)(\?.*)?$/i;
  if (directMediaExt.test(parsed.pathname)) {
    return { type: SOURCE_TYPES.NATIVE, payload: { url } };
  }

  // ── 3. HLS / m3u8 потоки ──────────────────────────────────
  if (parsed.pathname.toLowerCase().endsWith('.m3u8')) {
    return { type: SOURCE_TYPES.HLS, payload: { url } };
  }

  // ── 4. VK Video / Embedded iframe ─────────────────────────
  const vkHosts = [
    'vk.com', 'm.vk.com', 'vkvideo.ru', 'vk.cc', 'vk.com/video',
  ];
  if (
    vkHosts.includes(host) ||
    host.endsWith('.vk.com') ||
    host.endsWith('.vkvideo.ru') ||
    // Более общий случай: любые embed/video-хостинги через iframe
    parsed.pathname.includes('/video') ||
    parsed.pathname.includes('/embed')
  ) {
    const embedUrl = buildEmbedUrl(parsed);
    if (embedUrl) {
      return { type: SOURCE_TYPES.IFRAME, payload: { embedUrl, originalUrl: url } };
    }
  }

  // ── 5. Фолбэк: любой http(s) URL — пробуем iframe ─────────
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    // Для неизвестных сайтов пытаемся встроить через iframe.
    // Многие сайты блокируют X-Frame-Options, поэтому может не работать —
    // пользователь увидит пустой экран и мы покажем ошибку.
    return { type: SOURCE_TYPES.IFRAME, payload: { embedUrl: url, originalUrl: url } };
  }

  return { type: SOURCE_TYPES.UNKNOWN, payload: null };
}

/**
 * Строит embed-ссылку для iframe.
 * Для VK (vk.com / vkvideo.ru) используется штатный embed-формат.
 */
function buildEmbedUrl(parsed) {
  const host = parsed.hostname.toLowerCase();

  // vkvideo.ru/video-xxxxx_xxxxxx → https://vkvideo.ru/video_ext.php?oid=...&id=...&hd=2
  if (host === 'vkvideo.ru' || host === 'vk.com' || host === 'm.vk.com' || host.endsWith('.vkvideo.ru')) {
    const m = parsed.pathname.match(/video(-?\d+)_(\d+)/);
    if (m) {
      const [, oid, id] = m;
      return `https://vkvideo.ru/video_ext.php?oid=${encodeURIComponent(oid)}&id=${encodeURIComponent(id)}&hd=2`;
    }
  }

  // Уже embed-ссылка
  if (parsed.pathname.includes('/video_ext.php')) {
    return parsed.href;
  }

  // Обобщённые embed для известных расширений
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

  // Фолбэк: если в пути уже есть /embed/ — это уже embed-ссылка
  if (parsed.pathname.includes('/embed/')) {
    return parsed.href;
  }

  return null;
}

/* ═══════════════════════════════════════════════════════════
   4. ОБЩИЙ ПЕРЕКЛЮЧАТЕЛЬ ПЛЕЕРОВ
   ═══════════════════════════════════════════════════════════ */

/**
 * Показывает нужный контейнер, скрывает остальные.
 */
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

/**
 * Сброс всех плееров (останов, очистка).
 * Вызывается при смене источника.
 */
function resetPlayers(keepVisible = false) {
  state.applyingRemote = true;

  // HTML5 video
  try { els.nativeVideo.pause(); } catch (e) { /* ignore */ }
  try { els.nativeVideo.removeAttribute('src'); } catch (e) { /* ignore */ }
  try { els.nativeVideo.load(); } catch (e) { /* ignore */ }
  els.nativeVideo.setAttribute('data-raw-url', '');
  if (typeof window.hlsInstance !== 'undefined' && window.hlsInstance) {
    try { window.hlsInstance.destroy(); } catch (e) { /* ignore */ }
    window.hlsInstance = null;
  }

  // YouTube
  if (state.ytPlayer && typeof state.ytPlayer.destroy === 'function') {
    try { state.ytPlayer.destroy(); } catch (e) { /* ignore */ }
  }
  state.ytPlayer = null;
  els.ytHost.innerHTML = ''; // очищаем контейнер под будущий плеер

  // iframe
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

// Колбэк, вызываемый YouTube IFrame API когда API готов.
// НЕ может быть стрелочной функцией — API ищет глобальную функцию.
window.onYouTubeIframeAPIReady = function () {
  console.log('[YouTube] IFrame API готов');
  state.ytReady = true;
  hideLoading();

  // Если во время загрузки API пользователь уже вставил ссылку —
  // загружаем её.
  if (state.pendingYouTubeVideoId) {
    loadYouTubeVideo(state.pendingYouTubeVideoId);
    state.pendingYouTubeVideoId = null;
  }
};

// Если YouTube API не загрузился за 10 секунд — сообщаем об ошибке
// вместо вечного чёрного экрана.
setTimeout(() => {
  if (!state.ytReady) {
    console.error('[YouTube] API не загрузился за 10 секунд');
    setStatus('⚠️ YouTube API не загрузился. Проверьте соединение.');
    showSnack('❌ Не удалось загрузить YouTube API');
    hideLoading();
  }
}, 10000);

/**
 * Загружает YouTube-видео (создаёт или переиспользует плеер).
 */
function loadYouTubeVideo(videoId, autoplay = true) {
  const host = els.ytHost;
  host.classList.remove('hidden');
  showOnlyShell('yt');

  if (!state.ytReady) {
    // API ещё грузится (или упал). Ставим в очередь.
    state.pendingYouTubeVideoId = videoId;
    setStatus('⏳ YouTube API загружается…');
    return;
  }

  if (!state.ytPlayer) {
    // Создаём новый элемент, который API превратит в плеер
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
          // YouTube IFrame API НЕ возвращает Promise из playVideo().
          // Вместо этого проверяем состояние плеера через onStateChange.
          // Если браузер заблокирует автовоспроизведение, плеер
          // останется в состоянии CUED (-1) / PAUSED — покажем подсказку.
          if (autoplay) {
            try { event.target.playVideo(); } catch (e) { /* ignore */ }

            // Проверяем через 1.5 сек, началось ли воспроизведение
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
    // Переиспользуем существующий плеер
    state.ytPlayer.loadVideoById(videoId, 0, autoplay ? 'large' : 'default');
  }
}

/**
 * Событие смены состояния YouTube-плеера.
 * Здесь — ключевая защита от петли событий:
 * если флаг applyingRemote = true, значит команда пришла с сервера,
 * и мы НЕ отправляем её обратно.
 */
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
      setStatus('▶ Воспроизведение');
      break;

    case YT.PlayerState.PAUSED:
      emitIfNeeded('PAUSE', {
        mediaType: SOURCE_TYPES.YOUTUBE,
        url: state.currentUrl,
        time: getYouTubeCurrentTime(),
      });
      setStatus('⏸ Пауза');
      break;

    case YT.PlayerState.ENDED:
      emitIfNeeded('PAUSE', {
        mediaType: SOURCE_TYPES.YOUTUBE,
        url: state.currentUrl,
        time: getYouTubeCurrentTime(),
      });
      setStatus('✓ Видео завершено');
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

/**
 * Загружает прямой медиа-файл или HLS-поток в <video>.
 */
function loadNativeOrHls(url, autoplay = true) {
  const video = els.nativeVideo;
  video.setAttribute('data-raw-url', url);
  showOnlyShell('video');

  // .m3u8 → HLS.js (или нативный HLS на Safari / iOS)
  if (url.toLowerCase().endsWith('.m3u8')) {
    if (window.Hls && Hls.isSupported()) {
      if (window.hlsInstance) {
        try { window.hlsInstance.destroy(); } catch (e) { /* ignore */ }
      }
      window.hlsInstance = new Hls({
        // Агрессивный старт + низкий буфер для лучшей синхронизации
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
      // Нативный HLS (Safari / iOS)
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
    // Прямой .mp4 / .webm и т.д.
    video.src = url;
    video.load();
    if (autoplay) {
      video.play().catch(() => handleAutoplayBlocked('видео'));
    }
  }

  // Для прямых .mp4 — скрываем индикатор по загрузке метаданных
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

  // Скрываем индикатор загрузки после небольшой паузы,
  // чтобы iframe успел начать рендериться
  setTimeout(hideLoading, 1500);
  setStatus('🖥 Встроенный плеер');
}

/* ═══════════════════════════════════════════════════════════
   8. ОСНОВНАЯ ТОЧКА ВХОДА ЗАГРУЗКИ МЕДИА
   ═══════════════════════════════════════════════════════════ */

/**
 * Парсим URL и запускаем правильный плеер.
 * ОПЦИЯ: если emit = true — уведомляем сервер (CHANGE_MEDIA),
 * чтобы все участники комнаты тоже загрузили это видео.
 */
function loadMedia(rawUrl, opts = {}) {
  const { emit = true, autoplay = true, incoming = false } = opts;

  const parsed = parseUrl(rawUrl);

  // ── Обработка ошибок ──────────────────────────────────────
  if (parsed.type === SOURCE_TYPES.UNKNOWN || !parsed.payload) {
    const errMsg = parsed.payload?.error || 'Не удалось распознать ссылку';
    console.error('[LoadMedia] Ошибка:', errMsg);
    setStatus('⚠️ ' + errMsg);
    showSnack('❌ ' + errMsg);
    return false;
  }

  // Запоминаем текущий URL и тип
  state.currentUrl = rawUrl.trim();
  state.currentType = parsed.type;

  // Сбрасываем старые плееры
  resetPlayers(true);

  // Показываем индикатор загрузки вместо чёрного экрана
  showLoading('Загрузка видео…');

  // ── Запускаем нужный плеер ────────────────────────────────
  switch (parsed.type) {
    case SOURCE_TYPES.YOUTUBE:
      loadYouTubeVideo(parsed.payload.videoId, autoplay && !incoming);
      setStatus('🎬 Загружаем YouTube…');
      break;

    case SOURCE_TYPES.HLS:
    case SOURCE_TYPES.NATIVE:
      loadNativeOrHls(parsed.payload.url, autoplay && !incoming);
      setStatus('📡 Загружаем видео…');
      break;

    case SOURCE_TYPES.IFRAME:
      loadIframe(parsed.payload.embedUrl);
      break;

    default:
      setStatus('⚠️ Неизвестный тип медиа');
      return false;
  }

  // ── Уведомляем остальных участников комнаты ───────────────
  // (черновик события CHANGE_MEDIA передаётся серверу)
  if (emit && !incoming) {
    emitIfNeeded('CHANGE_MEDIA', {
      mediaType: parsed.type,
      url: state.currentUrl,
      time: 0,
    });
  }

  try {
    els.urlInput.value = '';
  } catch (e) { /* ignore */ }

  return true;
}

/* ═══════════════════════════════════════════════════════════
   9. SOCKET.IO — ПОДКЛЮЧЕНИЕ И ОБРАБОТКА СОБЫТИЙ
   ═══════════════════════════════════════════════════════════ */

/**
 * Подключение к серверу Socket.io.
 * Используем тот же origin, где открыт сайт (render/railway настроят сами).
 */
function connectSocket() {
  // При определении адреса поддерживаем локальный запуск:
  //  - на localhost / 127.0.0.1 используем текущий origin
  //  - в Telegram Mini App origin всегда будет HTTPS (после деплоя)
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

  // ── Пришёл запрос от нового участника: отдаём ему состояние ──
  s.on('request_state', ({ from }) => {
    console.log('[Socket] Запрос состояния от', from);

    // Если у нас уже есть загруженное видео — отправляем его
    if (state.currentUrl && state.currentType !== SOURCE_TYPES.UNKNOWN) {
      const time = getCurrentPlayhead();
      s.emit('CHANGE_MEDIA', {
        mediaType: state.currentType,
        url: state.currentUrl,
        time,
        forPeer: from, // сервер это проигнорирует, но для читаемости логов
      });
      // Дополнительно отправим актуальное время, чтобы новый
      // участник сразу перемотал на правильную позицию
      setTimeout(() => {
        s.emit('SEEK', {
          mediaType: state.currentType,
          url: state.currentUrl,
          time,
        });
      }, 300);
    }
  });

  // ── Ивенты синхронизации (команды от других участников) ──
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
    showSnack('👋 Участник покинул комнату');
  });

  s.on('PEERS', ({ peers, count }) => {
    console.log('[Sync] PEERS ←', peers, '| count:', count);
    state.peers = peers.map((id, i) => ({
      id,
      name: i === 0 ? 'Участник 1' : 'Участник ' + (i + 1),
    }));
    renderPeersModal();
  });
}

/**
 * Emit события на сервер.
 * Если emitIfNeeded вызывается со стороны локального события плеера
 * (напр. onplay), а мы в этот момент применяем remote-команду —
 * событие НЕ отправляется (защита от петли).
 */
function emitIfNeeded(eventName, payload) {
  if (state.applyingRemote) {
    console.log('[Emit] Пропуск (applyingRemote)', eventName);
    return;
  }
  state.socket.emit(eventName, {
    ...payload,
    sender: state.userId || state.socket.id,
  });
}

/* ═══════════════════════════════════════════════════════════
   10. ОБРАБОТЧИКИ REMOTE-КОМАНД
   ═══════════════════════════════════════════════════════════ */

/**
 * Устанавливает флаг applyingRemote на время выполнения команды,
 * чтобы локальные события плеера не порождали ответные события.
 */
function withRemoteFlag(fn) {
  state.applyingRemote = true;
  try {
    fn();
  } finally {
    // Небольшая задержка, чтобы всплеск событий (например,
    // серия событий buffering/playing) успел обработаться.
    setTimeout(() => {
      state.applyingRemote = false;
    }, 50);
  }
}

function handleRemotePlay(data) {
  const type = data.mediaType || state.currentType;

  // Если у нас другое видео — догружаем его, но НЕ запускаем
  if (data.url && data.url !== state.currentUrl) {
    handleRemoteMedia({ ...data, autoplay: false });
  }

  withRemoteFlag(() => {
    switch (type) {
      case SOURCE_TYPES.YOUTUBE:
        if (state.ytPlayer && typeof state.ytPlayer.playVideo === 'function') {
          try { state.ytPlayer.playVideo(); } catch (e) { /* ignore */ }
          // Точная синхронизация времени
          if (typeof data.time === 'number' && data.time > 0) {
            syncYouTubeTime(data.time);
          }
        }
        break;

      case SOURCE_TYPES.NATIVE:
      case SOURCE_TYPES.HLS:
        // Точное время: если сильно разошлись — перематываем
        const desired = data.time || 0;
        const current = els.nativeVideo.currentTime || 0;
        if (Math.abs(desired - current) > SYNC_THRESHOLD_SECONDS && desired > 0) {
          els.nativeVideo.currentTime = desired;
        }
        els.nativeVideo.play().catch(() => handleAutoplayBlocked('видео'));
        break;

      case SOURCE_TYPES.IFRAME:
        // Еслиrame-плееры (VK и др.) не дают API синхронизации времени.
        // Максимум, что можем — просто показать и надеяться на эмбед.
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
        // Если медиа ещё не загружено — ставим "pending seek"
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
    // То же видео — ничего не делаем (или корректируем время)
    if (typeof time === 'number' && time > 0) {
      handleRemoteSeek({ ...data, mediaType: mediaType || state.currentType, time });
    }
    return;
  }

  console.log('[Sync] Загружаем удалённое медиа:', mediaType, url);

  // Загружаем НОВОЕ видео. incoming=true → не отправлять CHANGE_MEDIA
  // обратно на сервер (защита от петли).
  loadMedia(url, {
    emit: false,
    autoplay: autoplay,
    incoming: true,
  });

  // Если гость приходит, когда видео уже играет у хоста —
  // применяем время из payload CHANGE_MEDIA.
  if (typeof time === 'number' && time > 0) {
    setTimeout(() => {
      handleRemoteSeek({ ...data, mediaType: mediaType || state.currentType, time });
      if (autoplay) {
        handleRemotePlay({ ...data, mediaType: mediaType || state.currentType, time });
      }
    }, 700);
  }
}

/* ═══════════════════════════════════════════════════════════
   11. СИНХРОНИЗАЦИЯ ВРЕМЕНИ
   ═══════════════════════════════════════════════════════════ */

/**
 * Текущая позиция воспроизведения (секунды) активного плеера.
 */
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

/**
 * Синхронизация YouTube: если расхождение > 0.5 сек — перематываем.
 */
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

/* ═══════════════════════════════════════════════════════════
   12. ИНТЕРВАЛ ПОДДЕРЖАНИЯ СИНХРОНИЗАЦИИ (ОПЦИОНАЛЬНО)
   ═══════════════════════════════════════════════════════════ */

/**
 * Фоновая задача: пока видео играет, каждые 5 секунд сверяем
 * время с сервером через SEEK-событие. Это «мягкая» синхронизация —
 * при малом расхождении ничего не происходит, при большом — перемотка.
 * Отключаем при паузе, чтобы не дёргать плеер.
 */
let syncInterval = null;

function startSyncLoop() {
  if (syncInterval) clearInterval(syncInterval);

  syncInterval = setInterval(() => {
    if (!state.socket || !state.connected) return;
    if (state.applyingRemote) return;

    const type = state.currentType;
    if (type !== SOURCE_TYPES.YOUTUBE && type !== SOURCE_TYPES.NATIVE && type !== SOURCE_TYPES.HLS) {
      return; // iframe не синхронизируем по времени
    }

    const time = getCurrentPlayhead();
    if (time <= 0) return;

    // Периодически шлём SEEK (сервер перешлёт остальным,
    // а они применят перемотку только при расхождении > 0.5с).
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
   13. СОБЫТИЯ ЛОКАЛЬНОГО HTML5-ПЛЕЕРА
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
    setStatus('▶ Воспроизведение');
    startSyncLoop();
  });

  video.addEventListener('pause', () => {
    if (state.applyingRemote) return;
    emitIfNeeded('PAUSE', {
      mediaType: SOURCE_TYPES.NATIVE,
      url: state.currentUrl,
      time: video.currentTime,
    });
    setStatus('⏸ Пауза');
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
    setStatus('✓ Видео завершено');
  });

  video.addEventListener('error', (e) => {
    console.error('[Video] Ошибка:', e);
    setStatus('⚠️ Ошибка воспроизведения видео');
    showSnack('❌ Не удалось воспроизвести видео');
    hideLoading();
  });
}

/* ═══════════════════════════════════════════════════════════
   14. UI-ХЕЛПЕРЫ
   ═══════════════════════════════════════════════════════════ */

function setStatus(text) {
  if (els.statusLabel) {
    els.statusLabel.textContent = text;
    els.statusLabel.title = text;
  }
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
  setStatus(`⚠️ Нажмите «Play», чтобы начать (${sourceName})`);
  showSnack('🔇 Автовоспроизведение заблокировано — нажмите Play');
}

/* ═══════════════════════════════════════════════════════════
   15. МОДАЛКА «ПИРЫ»
   ═══════════════════════════════════════════════════════════ */

function renderPeersModal() {
  if (!modalOverlayEl) return;

  const listEl = modalOverlayEl.querySelector('.peers-list');
  const countEl = modalOverlayEl.querySelector('.peer-count');

  if (countEl) {
    countEl.textContent = `Всего в комнате: ${state.peers.length + 1}`;
  }

  if (!listEl) return;

  if (state.peers.length === 0) {
    listEl.innerHTML = `
      <div class="peer-item">
        <div class="peer-avatar">🎬</div>
        <div class="peer-name">Вы одни в комнате</div>
        <span class="peer-id">—</span>
      </div>
    `;
    return;
  }

  listEl.innerHTML = state.peers.map((peer, i) => `
    <div class="peer-item">
      <div class="peer-avatar">${peer.name.charAt(0).toUpperCase()}</div>
      <div class="peer-name">${escapeHtml(peer.name)}</div>
      <span class="peer-id">${escapeHtml(shortId(peer.id))}</span>
    </div>
  `).join('');
}

function openPeersModal() {
  if (!modalOverlayEl) {
    modalOverlayEl = document.createElement('div');
    modalOverlayEl.className = 'modal-overlay';
    modalOverlayEl.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-title">
          👥 Участники
          <div class="peer-count" style="font-size:12px;color:var(--tg-hint);font-weight:400;margin-top:4px;"></div>
        </div>
        <div class="peers-list"></div>
        <button class="modal-close" type="button">Закрыть</button>
      </div>
    `;

    modalOverlayEl.addEventListener('click', (event) => {
      if (event.target === modalOverlayEl || event.target.classList.contains('modal-close')) {
        modalOverlayEl.classList.remove('show');
      }
    });

    document.body.appendChild(modalOverlayEl);
  }

  // Запрашиваем актуальный список пиров на сервере
  state.socket.emit('GET_PEERS');

  modalOverlayEl.classList.add('show');
  renderPeersModal();
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
    // Копирование не сработало — показываем URL в input и в snackbar
    console.warn('[Invite] Clipboard недоступен:', e);
    els.urlInput.value = inviteUrl;
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
  // NB: используем String.fromCharCode(38) для '&', чтобы автоформатирование
  // редактора (конвертация HTML-сущностей) не сломало экранирование.
  const ESCAPE_MAP = {
    '&': String.fromCharCode(38) + 'amp;',
    '<': String.fromCharCode(38) + 'lt;',
    '>': String.fromCharCode(38) + 'gt;',
    '"': String.fromCharCode(38) + 'quot;',
    "'": String.fromCharCode(38) + '#39;',
  };

  return String(str).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

function shortId(id) {
  if (!id) return '—';
  return id.slice(0, 8);
}

/* ═══════════════════════════════════════════════════════════
   18. ОБРАБОТКА UI-СОБЫТИЙ
   ═══════════════════════════════════════════════════════════ */

function bindUI() {
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
    if (url) {
      loadMedia(url);
    }
  });

  // Пригласить
  els.inviteBtn.addEventListener('click', inviteFriend);

  // Пиры
  els.peersBtn.addEventListener('click', openPeersModal);

  // Сброс
  els.resetBtn.addEventListener('click', () => {
    resetPlayers(false);
    stopSyncLoop();
    state.currentType = SOURCE_TYPES.UNKNOWN;
    state.currentUrl = '';
    setStatus('Ожидание видео…');
    showSnack('↺ Плеер сброшен');
  });
}

/* ═══════════════════════════════════════════════════════════
   19. ИНИЦИАЛИЗАЦИЯ
   ═══════════════════════════════════════════════════════════ */

(function init() {
  console.log('%c RAVE TMA v1.0 — синхронный просмотр ', 'background:#5288c1;color:#fff;font-size:14px;padding:6px;border-radius:4px');

  // Telegram SDK
  initTelegram();

  // Отображаем комнату в бейдже
  els.roomBadge.textContent = state.roomId;
  els.roomBadge.title = 'Комната: ' + state.roomId;

  // Привязка UI
  bindUI();

  // Локальные события HTML5-плеера
  bindNativeVideoEvents();

  // Подключаемся к Socket.io
  connectSocket();

  // Статус
  setStatus('Ожидание видео…');

  // Автозапуск по URL ?media=... (удобно для прямых ссылок из чата)
  const mediaParam = new URLSearchParams(window.location.search).get('media');
  if (mediaParam) {
    setTimeout(() => loadMedia(mediaParam), 500);
  }
})();