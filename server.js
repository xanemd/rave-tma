/**
 * RAVE TMA — Telegram Mini App
 * Сервер синхронизации для совместного просмотра видео
 *
 * Архитектура как в Rave:
 *  - Сервер хранит состояние комнаты (текущее видео, позиция, isPlaying)
 *  - Серверное время — эталон для синхронизации
 *  - Первый участник комнаты = хост (только он может менять видео)
 *  - Новый гость получает полное состояние комнаты при подключении
 *  - Очередь видео (хост может добавить несколько)
 *
 * ─────────────────────────────────────────────────────────────
 * 1) ЛОКАЛЬНЫЙ ЗАПУСК:
 *    npm install && node server.js
 *    Затем открой http://localhost:3000 (или порт из process.env.PORT)
 *
 * 2) ДЕПЛОЙ НА RENDER.COM / RAILWAY:
 *    Залить проект в GitHub → подключить на хостинге.
 *    Start Command: npm start
 * ─────────────────────────────────────────────────────────────
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ─────────────────────────────────────────────────────────────
// СТАТИКА
// ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────────────────────
// КОМНАТЫ И СОСТОЯНИЕ
// ─────────────────────────────────────────────────────────────

// Состояние каждой комнаты:
// {
//   hostId: socket.id хоста,
//   currentUrl: '',
//   currentType: null,
//   isPlaying: false,
//   anchorTime: 0,        // позиция видео в секундах на момент старта/перемотки/паузы
//   anchorTimestamp: 0,   // время сервера (Date.now()) на момент старта/перемотки/паузы
//   queue: [],            // очередь видео [{url, type}]
//   viewers: 0,
//   messages: [],         // история чата
//   reactions: {},        // реакции на сообщения { messageId: { emoji: [userIds] } }
//   createdAt: Date.now(),
//   name: ''              // отображаемое имя комнаты
// }
const rooms = new Map();

/**
 * Универсальный хелпер безопасного получения комнаты.
 * Никогда не создаёт комнату автоматически и не роняет Node.js
 * при `rooms.get(undefined)`.
 */
function getRoom(roomId) {
  if (!roomId || typeof roomId !== 'string') return null;
  return rooms.get(roomId) || null;
}

function createRoomRecord(roomId, name, hostId) {
  return {
    id: roomId,
    name: (name && String(name).trim().slice(0, 64)) || 'НАША СПАЛЬНЯ 😉',
    hostId,
    currentUrl: '',
    currentType: null,
    isPlaying: false,
    anchorTime: 0,
    anchorTimestamp: 0,
    queue: [],
    viewers: 1,
    users: new Map(),
    messages: [],
    reactions: {},
    createdAt: Date.now(),
  };
}

function getPublicRoomsList() {
  const list = [];
  for (const [id, room] of rooms.entries()) {
    // Надёжный подсчёт: берём max из нашего viewers и adapter (на случай рассинхрона)
    const adapterCount = io.sockets.adapter.rooms.get(id)?.size || 0;
    const usersCount = Math.max(adapterCount, room.viewers || 1, 1);
    list.push({
      id,
      name: room.name || id,
      hostId: room.hostId,
      usersCount,
    });
  }
  return list;
}

function broadcastRoomsUpdate() {
  io.emit('rooms-updated', getPublicRoomsList());
}

/**
 * Server-side Master Clock: вычисляет текущую позицию видео по серверному времени.
 * Если видео играет: anchorTime + (now - anchorTimestamp) / 1000
 * Если на паузе: anchorTime
 */
function getRoomTime(room) {
  if (!room.isPlaying) return room.anchorTime;
  const now = Date.now();
  return room.anchorTime + (now - room.anchorTimestamp) / 1000;
}

/**
 * Собирает sync-state payload — единый формат для рассылки всем клиентам.
 * Содержит текущую позицию, статус воспроизведения и метаданные видео.
 */
function buildSyncState(room, serverTimestamp) {
  return {
    serverTime: getRoomTime(room),
    isPlaying: room.isPlaying,
    serverTimestamp: serverTimestamp || Date.now(),
    currentUrl: room.currentUrl,
    currentType: room.currentType,
  };
}

/**
 * Полное состояние комнаты для нового гостя.
 */
function getRoomState(room) {
  return {
    hostId: room.hostId,
    currentUrl: room.currentUrl,
    currentType: room.currentType,
    isPlaying: room.isPlaying,
    anchorTime: room.anchorTime,
    anchorTimestamp: room.anchorTimestamp,
    serverTime: getRoomTime(room),
    serverTimestamp: Date.now(),
    queue: room.queue,
    viewers: room.viewers,
  };
}

io.on('connection', (socket) => {
  const roomId = sanitizeRoom(socket.handshake.query.room);
  const hasRoom = Boolean(roomId);

  // Всегда устанавливаем currentRoomId (null для лобби).
  // Это ключевая защита от падения `rooms.get(undefined)`.
  socket.currentRoomId = roomId || null;

  if (hasRoom) {
    socket.join(roomId);

    let room = getRoom(roomId);
    if (!room) {
      room = createRoomRecord(roomId, roomId, null);
      rooms.set(roomId, room);
    }
    room.viewers += 1;

    const isHost = !room.hostId;
    if (isHost) {
      room.hostId = socket.id;
    }

    console.log(
      `[+] ${socket.id} подключился в "${roomId}" ` +
      `(зрителей: ${room.viewers}, хост: ${room.hostId === socket.id ? 'ДА' : room.hostId})`
    );

    socket.emit('hello', {
      roomId,
      socketId: socket.id,
      isHost,
      viewers: room.viewers,
      message: 'Подключено к комнате синхронизации'
    });

    socket.emit('init-room-state', getRoomState(room));

    if (room.messages.length > 0) {
      socket.emit('CHAT_HISTORY', { messages: room.messages.slice(-50) });
    }

    if (Object.keys(room.reactions).length > 0) {
      socket.emit('ALL_REACTIONS', { reactions: room.reactions });
    }

    socket.to(roomId).emit('USER_JOINED', {
      id: socket.id,
      isHost,
      viewers: room.viewers,
    });

    broadcastRoomsUpdate();
  } else {
    socket.emit('hello', {
      roomId: null,
      socketId: socket.id,
      isHost: false,
      viewers: 0,
      message: 'Подключено к лобби'
    });
  }

  socket.emit('rooms-updated', getPublicRoomsList());

  // ── Служебные события ──────────────────────────────────────
  socket.on('get-rooms', () => {
    socket.emit('rooms-updated', getPublicRoomsList());
  });

  socket.on('PING', ({ clientTime } = {}) => {
    socket.emit('PONG', { clientTime, serverTime: Date.now() });
  });

  // ── Безопасное создание комнаты ─────────────────────────────
  socket.on('create-room', (data, callback) => {
    try {
      const roomId = 'r_' + Math.random().toString(36).substring(2, 9);
      const newRoom = createRoomRecord(roomId, data && data.name, socket.id);

      rooms.set(roomId, newRoom);

      // Покидаем предыдущую комнату (если была создана из query при подключении),
      // чтобы socket не висел в двух комнатах и список комнат был корректным.
      if (socket.currentRoomId && socket.currentRoomId !== roomId) {
        const oldRoomId = socket.currentRoomId;
        socket.leave(oldRoomId);
        // Если в старой комнате больше никого не осталось — удаляем её из rooms,
        // чтобы пустые комнаты не засоряли список.
        const oldAdapterRoom = io.sockets.adapter.rooms.get(oldRoomId);
        if (!oldAdapterRoom || oldAdapterRoom.size === 0) {
          const oldRoom = getRoom(oldRoomId);
          if (oldRoom) {
            oldRoom.viewers = Math.max(0, (oldRoom.viewers || 1) - 1);
            if (oldRoom.viewers === 0) {
              rooms.delete(oldRoomId);
            }
          }
        }
      }

      socket.join(roomId);
      socket.currentRoomId = roomId;

      // Сообщаем клиенту, что он теперь хост созданной комнаты
      socket.emit('hello', {
        roomId,
        socketId: socket.id,
        isHost: true,
        viewers: 1,
        message: 'Комната создана'
      });

      // Отдаем клиенту подтверждение с ID созданной комнаты
      if (typeof callback === 'function') callback({ success: true, roomId });

      io.emit('rooms-updated', getPublicRoomsList());
    } catch (err) {
      console.error('Create room error:', err);
    }
  });

  // ── Безопасное подключение к комнате ────────────────────────
  socket.on('join-room', (data) => {
    const roomId = (data && data.roomId) || socket.currentRoomId;
    const room = getRoom(roomId);
    if (!room) {
      socket.emit('error-msg', 'Комната не найдена');
      return;
    }

    const alreadyInRoom = Boolean(io.sockets.adapter.rooms.get(roomId)?.has(socket.id));
    socket.join(roomId);
    socket.currentRoomId = roomId;
    if (!room.users) room.users = new Map();
    room.users.set(socket.id, { id: socket.id });
    if (!alreadyInRoom) room.viewers += 1;

    socket.emit('hello', {
      roomId,
      socketId: socket.id,
      isHost: room.hostId === socket.id,
      viewers: room.viewers,
      message: 'Подключено к комнате синхронизации'
    });

    // Отправляем текущее состояние видео новенькому
    socket.emit('init-room-state', getRoomState(room));

    io.emit('rooms-updated', getPublicRoomsList());
  });

  // ── Чат (безопасная отправка сообщений) ────────────────────
  // ПРЕДОТВРАЩАЕТ ПАДЕНИЕ СЕРВЕРА при обращении к несуществующей комнате.
    socket.on('send-message', (data) => {
      const currentId = socket.currentRoomId;
      const room = getRoom(currentId);
      if (!room) return;

      const payload = normalizeChat(data, socket.id);
      if (!payload) return;

      room.messages.push(payload);
      if (room.messages.length > 50) room.messages.shift();

      console.log(`💬 CHAT   | ${socket.id} | room=${currentId}`, payload.text);
      io.to(currentId).emit('CHAT', payload);
    });

  // ── Смена видео (безопасная) ────────────────────────────────
  socket.on('CHANGE_MEDIA', (data) => {
    const room = getRoom(roomId);
    if (!room) return;

    room.currentUrl = url;
    room.anchorTime = 0;
    room.anchorTimestamp = Date.now();
    room.isPlaying = false;
  });

  // ── Выход из комнаты ────────────────────────────────────────
  socket.on('leave-room', () => {
    console.log(`🚶 LEAVE  | ${socket.id} | room=${socket.currentRoomId || '—'}`);
    socket.currentRoomId = null;
    broadcastRoomsUpdate();
  });

  // ─────────────────────────────────────────────────────────────
  // ОБРАБОТКА ИВЕНТОВ СИНХРОНИЗАЦИИ
  // Регистрируются для КАЖДОГО сокета. Комната резолвится динамически
  // через socket.currentRoomId — поэтому хендлеры работают и для
  // соединений без ?room= в query (например, после create-room/join-room).
  // Только хост может управлять видео (как в Rave).
  // ─────────────────────────────────────────────────────────────

  socket.on('PLAY', (data) => {
    const currentId = socket.currentRoomId;
    const room = getRoom(currentId);
    if (!room) return;
    if (socket.id !== room.hostId) {
      socket.emit('ERROR', { message: 'Только хост может управлять видео' });
      return;
    }

    const payload = normalizePayload(data);
    const time = typeof payload.time === 'number' ? payload.time : getRoomTime(room);

    room.isPlaying = true;
    room.anchorTime = time;
    room.anchorTimestamp = Date.now();

    console.log(`▶  PLAY   | ${socket.id} | room=${currentId} | pos=${time.toFixed(1)}`);
     io.to(currentId).emit('sync-state', buildSyncState(room));
   });

   socket.on('PAUSE', (data) => {
    const currentId = socket.currentRoomId;
    const room = getRoom(currentId);
    if (!room) return;

    if (socket.id !== room.hostId) {
      socket.emit('ERROR', { message: 'Только хост может управлять видео' });
      return;
    }

    const payload = normalizePayload(data);
    const time = typeof payload.time === 'number' ? payload.time : getRoomTime(room);

    room.isPlaying = false;
    room.anchorTime = time;
    room.anchorTimestamp = Date.now();

    console.log(`⏸  PAUSE  | ${socket.id} | room=${currentId} | pos=${time.toFixed(1)}`);
    io.to(currentId).emit('sync-state', buildSyncState(room));
  });

  socket.on('SEEK', (data) => {
    const currentId = socket.currentRoomId;
    const room = getRoom(currentId);
    if (!room) return;

    if (socket.id !== room.hostId) {
      socket.emit('ERROR', { message: 'Только хост может управлять видео' });
      return;
    }

    const payload = normalizePayload(data);
    const time = typeof payload.time === 'number' ? payload.time : 0;

    room.anchorTime = time;
    room.anchorTimestamp = Date.now();

     console.log(`⏩ SEEK   | ${socket.id} | room=${currentId} | pos=${time.toFixed(1)}`);
     io.to(currentId).emit('sync-state', buildSyncState(room));
   });

   // ── Динамическая синхронизация (Rave: Server-side Master Clock) ───
  socket.on('player-action', ({ roomId, action, time }) => {
    const room = getRoom(roomId);
    if (!room) return;

    const now = Date.now();

    if (action === 'play') {
      room.isPlaying = true;
      room.anchorTime = time;
      room.anchorTimestamp = now;
    } else if (action === 'pause') {
      room.isPlaying = false;
      room.anchorTime = time;
      room.anchorTimestamp = now;
    } else if (action === 'seek') {
      room.anchorTime = time;
      room.anchorTimestamp = now;
    }

     io.to(roomId).emit('sync-state', buildSyncState(room, now));
  });

  // ── Периодическая синхронизация времени от хоста ─────────────
  socket.on('sync-video', (data) => {
    const currentId = socket.currentRoomId;
    const room = getRoom(currentId);
    if (!room) return;

    if (socket.id !== room.hostId) {
      socket.emit('ERROR', { message: 'Только хост может отправлять синхронизацию' });
      return;
    }

    const now = Date.now();
    const currentTime = typeof data.currentTime === 'number' ? data.currentTime : getRoomTime(room);
    const isPaused = typeof data.isPaused === 'boolean' ? data.isPaused : !room.isPlaying;

    room.anchorTime = currentTime;
    room.anchorTimestamp = now;
    if (!isPaused && !room.isPlaying) {
      room.isPlaying = true;
    } else if (isPaused && room.isPlaying) {
      room.isPlaying = false;
    }

     io.to(currentId).emit('sync-state', buildSyncState(room));
   });

  // ── Очередь видео ──────────────────────────────────────────
  socket.on('ADD_TO_QUEUE', (data) => {
    const currentId = socket.currentRoomId;
    const room = getRoom(currentId);
    if (!room) return;

    if (socket.id !== room.hostId) {
      socket.emit('ERROR', { message: 'Только хост может добавлять в очередь' });
      return;
    }

    const url = String(data?.url || '').slice(0, 2000);
    const type = String(data?.mediaType || '').slice(0, 32);
    if (!url) return;

    room.queue.push({ url, type });
    console.log(`➕ QUEUE  | ${socket.id} | room=${currentId} | добавлено: ${url.slice(0, 50)}`);

    io.to(currentId).emit('QUEUE_UPDATED', { queue: room.queue });
  });

  socket.on('REMOVE_FROM_QUEUE', (data) => {
    const currentId = socket.currentRoomId;
    const room = getRoom(currentId);
    if (!room) return;

    if (socket.id !== room.hostId) return;

    const index = Number(data?.index);
    if (Number.isInteger(index) && index >= 0 && index < room.queue.length) {
      room.queue.splice(index, 1);
      io.to(currentId).emit('QUEUE_UPDATED', { queue: room.queue });
    }
  });

  socket.on('NEXT_IN_QUEUE', () => {
    const currentId = socket.currentRoomId;
    const room = getRoom(currentId);
    if (!room) return;

    if (socket.id !== room.hostId) return;

    const next = room.queue.shift();
    if (!next) return;

    room.currentUrl = next.url;
    room.currentType = next.type;
    room.isPlaying = true;
    room.anchorTime = 0;
    room.anchorTimestamp = Date.now();

    console.log(`⏭ NEXT   | ${socket.id} | room=${currentId} | ${next.url.slice(0, 50)}`);

     io.to(currentId).emit('sync-state', buildSyncState(room));
     io.to(currentId).emit('QUEUE_UPDATED', { queue: room.queue });
  });

  // ── Чат ─────────────────────────────────────────────────────
  socket.on('CHAT', (data) => {
    const currentId = socket.currentRoomId;
    const room = getRoom(currentId);
    if (!room) return;

    const payload = normalizeChat(data, socket.id);
    if (!payload) return;

    room.messages.push(payload);
    if (room.messages.length > 50) room.messages.shift();

    console.log(`💬 CHAT   | ${socket.id} | room=${currentId}`, payload.text);
    io.to(currentId).emit('CHAT', payload);
  });

  // ── Реакции на сообщения ───────────────────────────────────
  socket.on('send-message-reaction', (data) => {
    const currentId = socket.currentRoomId;
    const room = getRoom(currentId);
    if (!room) return;

    const messageId = String(data?.messageId || '');
    const emoji = String(data?.emoji || '');
    if (!messageId || !emoji) return;

    if (!room.reactions) room.reactions = {};
    if (!room.reactions[messageId]) room.reactions[messageId] = {};

    const emojiKey = emoji;
    if (!room.reactions[messageId][emojiKey]) {
      room.reactions[messageId][emojiKey] = [];
    }

    const userIndex = room.reactions[messageId][emojiKey].indexOf(socket.id);
    if (userIndex >= 0) {
      room.reactions[messageId][emojiKey].splice(userIndex, 1);
      if (room.reactions[messageId][emojiKey].length === 0) {
        delete room.reactions[messageId][emojiKey];
      }
    } else {
      room.reactions[messageId][emojiKey].push(socket.id);
    }

    io.to(currentId).emit('message-reaction-updated', {
      messageId,
      emoji,
      userId: socket.id,
      reactions: room.reactions[messageId],
    });
  });

  // ── Пиры ────────────────────────────────────────────────────
  socket.on('GET_PEERS', () => {
    const currentId = socket.currentRoomId;
    const room = getRoom(currentId);
    if (!room) return;

    const peers = [...io.sockets.adapter.rooms.get(currentId) || []]
      .filter((id) => id !== socket.id);
    socket.emit('PEERS', { peers, count: peers.length, hostId: room.hostId });
  });

  // ── Отключение ──────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    const currentId = socket.currentRoomId;
    const room = getRoom(currentId);
    if (!room) return;

    room.viewers = Math.max(0, room.viewers - 1);

    console.log(
      `[-] ${socket.id} отключился из "${currentId}" ` +
      `(причина: ${reason}; зрителей: ${room.viewers})`
    );

    socket.to(currentId).emit('USER_LEFT', { id: socket.id, viewers: room.viewers });

    if (room.hostId === socket.id) {
      const remaining = [...io.sockets.adapter.rooms.get(currentId) || []];
      if (remaining.length > 0) {
        room.hostId = remaining[0];
        console.log(`👑 Новый хост комнаты "${currentId}": ${room.hostId}`);
        io.to(currentId).emit('HOST_CHANGED', { hostId: room.hostId });
      } else {
        room.hostId = null;
      }
    }

    const remainingAfter = [...io.sockets.adapter.rooms.get(currentId) || []];
    if (remainingAfter.length === 0) {
      rooms.delete(currentId);
      console.log(`[🗑] Комната "${currentId}" удалена (пуста)`);
    }

    broadcastRoomsUpdate();
  });

  socket.on('error', (err) => {
    console.error(`[!] Ошибка сокета ${socket.id}:`, err.message);
  });
});

// ── Фоновый тикер: удержание синхронизации каждые 3 секунды ───
 setInterval(() => {
   rooms.forEach((room, roomId) => {
     if (room.isPlaying) {
       io.to(roomId).emit('sync-state', buildSyncState(room));
     }
   });
 }, 3000);

// ─────────────────────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ─────────────────────────────────────────────────────────────

function normalizePayload(data) {
  if (!data || typeof data !== 'object') return { time: Date.now() };
  const time = typeof data.time === 'number' ? data.time : Date.now();
  return {
    ...data,
    time,
  };
}

function sanitizeRoom(room) {
  if (typeof room !== 'string') return null;
  const cleaned = room.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned || null;
}

function normalizeChat(data, socketId) {
  if (!data || typeof data !== 'object') return null;
  const text = String(data.text || '').trim().slice(0, 500);
  if (!text) return null;

  return {
    id: `${socketId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    text,
    sender: String(data.sender || 'Гость').slice(0, 64),
    socketId,
    time: Date.now(),
    replyToId: data.replyToId ? String(data.replyToId).slice(0, 100) : null,
    replyToText: data.replyToText ? String(data.replyToText).slice(0, 200) : null,
    replyToSender: data.replyToSender ? String(data.replyToSender).slice(0, 64) : null,
  };
}

// ─────────────────────────────────────────────────────────────
// ЗАПУСК СЕРВЕРА
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║   RAVE TMA — синхронный просмотр видео       ║`);
  console.log(`║   Сервер запущен: http://localhost:${PORT}       ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  console.log(`Статика раздаётся из: ${path.join(__dirname, 'public')}`);
});