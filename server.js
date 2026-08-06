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
//   position: 0,          // позиция в момент паузы (сек)
//   startedAt: 0,         // серверное время начала воспроизведения (мс)
//   queue: [],            // очередь видео [{url, type}]
//   viewers: 0,
//   messages: [],         // история чата
//   reactions: {},        // реакции на сообщения { messageId: { emoji: [userIds] } }
//   createdAt: Date.now(),
//   name: ''              // отображаемое имя комнаты
// }
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      hostId: null,
      currentUrl: '',
      currentType: null,
      isPlaying: false,
      position: 0,
      startedAt: 0,
      queue: [],
      viewers: 0,
      messages: [],
      reactions: {},
      createdAt: Date.now(),
      name: roomId,
    });
  }
  return rooms.get(roomId);
}

function getPublicRoomsList() {
  const list = [];
  for (const [id, room] of rooms.entries()) {
    const usersCount = io.sockets.adapter.rooms.get(id)?.size || 0;
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
 * Вычисляет текущую позицию видео по серверному времени.
 * Если видео играет: position + (now - startedAt) / 1000
 * Если на паузе: position
 */
function getCurrentPosition(room) {
  if (room.isPlaying && room.startedAt > 0) {
    return Math.max(0, room.position + (Date.now() - room.startedAt) / 1000);
  }
  return room.position;
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
    position: getCurrentPosition(room),
    startedAt: room.startedAt,
    queue: room.queue,
    viewers: room.viewers,
    serverTime: Date.now(),
  };
}

io.on('connection', (socket) => {
  const roomId = sanitizeRoom(socket.handshake.query.room);
  const hasRoom = Boolean(roomId);

  if (hasRoom) {
    socket.join(roomId);

    const room = getRoom(roomId);
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

    socket.emit('init-room-state', {
      currentUrl: room.currentUrl,
      currentType: room.currentType,
      currentTime: getCurrentPosition(room),
      isPlaying: room.isPlaying,
      startedAt: room.startedAt,
      serverTime: Date.now(),
      queue: room.queue,
      viewers: room.viewers,
    });

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

  socket.on('get-rooms', () => {
    socket.emit('rooms-updated', getPublicRoomsList());
  });

  // ── Обработка ивентов синхронизации ────────────────────────
  // Только хост может управлять видео (как в Rave)

  if (hasRoom) {
    socket.on('PLAY', (data) => {
      if (socket.id !== room.hostId) {
        socket.emit('ERROR', { message: 'Только хост может управлять видео' });
        return;
      }

      const payload = normalizePayload(data);
      const pos = typeof payload.time === 'number' ? payload.time : getCurrentPosition(room);

      room.isPlaying = true;
      room.position = pos;
      room.startedAt = Date.now();

      console.log(`▶  PLAY   | ${socket.id} | room=${roomId} | pos=${pos.toFixed(1)}`);
      io.to(roomId).emit('ROOM_STATE', getRoomState(room));
    });

    socket.on('PAUSE', (data) => {
      if (socket.id !== room.hostId) {
        socket.emit('ERROR', { message: 'Только хост может управлять видео' });
        return;
      }

      const payload = normalizePayload(data);
      const pos = getCurrentPosition(room);

      room.isPlaying = false;
      room.position = pos;
      room.startedAt = 0;

      console.log(`⏸  PAUSE  | ${socket.id} | room=${roomId} | pos=${pos.toFixed(1)}`);
      io.to(roomId).emit('ROOM_STATE', getRoomState(room));
    });

    socket.on('SEEK', (data) => {
      if (socket.id !== room.hostId) {
        socket.emit('ERROR', { message: 'Только хост может управлять видео' });
        return;
      }

      const payload = normalizePayload(data);
      const pos = typeof payload.time === 'number' ? payload.time : 0;

      room.position = pos;
      if (room.isPlaying) {
        room.startedAt = Date.now();
      }

      console.log(`⏩ SEEK   | ${socket.id} | room=${roomId} | pos=${pos.toFixed(1)}`);
      io.to(roomId).emit('ROOM_STATE', getRoomState(room));
    });

    socket.on('CHANGE_MEDIA', (data) => {
      if (socket.id !== room.hostId) {
        socket.emit('ERROR', { message: 'Только хост может менять видео' });
        return;
      }

      const payload = normalizePayload(data);
      const url = String(payload.url || '').slice(0, 2000);
      const type = String(payload.mediaType || '').slice(0, 32);

      if (!url) return;

      room.currentUrl = url;
      room.currentType = type;
      room.isPlaying = true;
      room.position = 0;
      room.startedAt = Date.now();

      console.log(`🎬 MEDIA  | ${socket.id} | room=${roomId} | ${type} | ${url.slice(0, 60)}`);
      io.to(roomId).emit('ROOM_STATE', getRoomState(room));
    });

    // ── Периодическая синхронизация времени от хоста ─────────────
    socket.on('sync-video', (data) => {
      if (socket.id !== room.hostId) {
        socket.emit('ERROR', { message: 'Только хост может отправлять синхронизацию' });
        return;
      }

      const currentTime = typeof data.currentTime === 'number' ? data.currentTime : getCurrentPosition(room);
      const isPaused = typeof data.isPaused === 'boolean' ? data.isPaused : !room.isPlaying;

      room.position = currentTime;
      if (!isPaused && !room.isPlaying) {
        room.isPlaying = true;
        room.startedAt = Date.now();
      } else if (isPaused && room.isPlaying) {
        room.isPlaying = false;
        room.startedAt = 0;
      }

      io.to(roomId).emit('sync-video-client', {
        currentTime,
        isPaused,
        serverTimestamp: Date.now(),
      });
    });

    // ── Управление публичными комнатами ─────────────────────────
    socket.on('create-room', (data) => {
      const name = String(data?.name || roomId).slice(0, 64);
      room.name = name || roomId;
      console.log(`🏠 CREATE | ${socket.id} | room=${roomId} | name=${room.name}`);
      broadcastRoomsUpdate();
    });

    socket.on('join-room', () => {
      console.log(`🚪 JOIN   | ${socket.id} | room=${roomId}`);
      broadcastRoomsUpdate();
    });

    socket.on('leave-room', () => {
      console.log(`🚶 LEAVE  | ${socket.id} | room=${roomId}`);
      broadcastRoomsUpdate();
    });

    // ── Очередь видео ──────────────────────────────────────────
    socket.on('ADD_TO_QUEUE', (data) => {
      if (socket.id !== room.hostId) {
        socket.emit('ERROR', { message: 'Только хост может добавлять в очередь' });
        return;
      }

      const url = String(data?.url || '').slice(0, 2000);
      const type = String(data?.mediaType || '').slice(0, 32);
      if (!url) return;

      room.queue.push({ url, type });
      console.log(`➕ QUEUE  | ${socket.id} | room=${roomId} | добавлено: ${url.slice(0, 50)}`);

      io.to(roomId).emit('QUEUE_UPDATED', { queue: room.queue });
    });

    socket.on('REMOVE_FROM_QUEUE', (data) => {
      if (socket.id !== room.hostId) return;

      const index = Number(data?.index);
      if (Number.isInteger(index) && index >= 0 && index < room.queue.length) {
        room.queue.splice(index, 1);
        io.to(roomId).emit('QUEUE_UPDATED', { queue: room.queue });
      }
    });

    socket.on('NEXT_IN_QUEUE', () => {
      if (socket.id !== room.hostId) return;

      const next = room.queue.shift();
      if (!next) return;

      room.currentUrl = next.url;
      room.currentType = next.type;
      room.isPlaying = true;
      room.position = 0;
      room.startedAt = Date.now();

      console.log(`⏭ NEXT   | ${socket.id} | room=${roomId} | ${next.url.slice(0, 50)}`);

      io.to(roomId).emit('CHANGE_MEDIA', {
        url: next.url,
        mediaType: next.type,
        time: 0,
        serverTime: Date.now(),
      });
      io.to(roomId).emit('QUEUE_UPDATED', { queue: room.queue });
    });

    // ── Чат ─────────────────────────────────────────────────────
    socket.on('CHAT', (data) => {
      const payload = normalizeChat(data, socket.id);
      if (!payload) return;

      room.messages.push(payload);
      if (room.messages.length > 50) room.messages.shift();

      console.log(`💬 CHAT   | ${socket.id} | room=${roomId}`, payload.text);
      io.to(roomId).emit('CHAT', payload);
    });

    // ── Реакции на сообщения ───────────────────────────────────
    socket.on('send-message-reaction', (data) => {
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

      io.to(roomId).emit('message-reaction-updated', {
        messageId,
        emoji,
        userId: socket.id,
        reactions: room.reactions[messageId],
      });
    });

    // ── Пиры ────────────────────────────────────────────────────
    socket.on('GET_PEERS', () => {
      const peers = [...io.sockets.adapter.rooms.get(roomId) || []]
        .filter((id) => id !== socket.id);
      socket.emit('PEERS', { peers, count: peers.length, hostId: room.hostId });
    });

    // ── Отключение ──────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      room.viewers = Math.max(0, room.viewers - 1);

      console.log(
        `[-] ${socket.id} отключился из "${roomId}" ` +
        `(причина: ${reason}; зрителей: ${room.viewers})`
      );

      socket.to(roomId).emit('USER_LEFT', { id: socket.id, viewers: room.viewers });

      if (room.hostId === socket.id) {
        const remaining = [...io.sockets.adapter.rooms.get(roomId) || []];
        if (remaining.length > 0) {
          room.hostId = remaining[0];
          console.log(`👑 Новый хост комнаты "${roomId}": ${room.hostId}`);
          io.to(roomId).emit('HOST_CHANGED', { hostId: room.hostId });
        } else {
          room.hostId = null;
        }
      }

      const remainingAfter = [...io.sockets.adapter.rooms.get(roomId) || []];
      if (remainingAfter.length === 0) {
        rooms.delete(roomId);
        console.log(`[🗑] Комната "${roomId}" удалена (пуста)`);
      }

      broadcastRoomsUpdate();
    });
  }

  socket.on('error', (err) => {
    console.error(`[!] Ошибка сокета ${socket.id}:`, err.message);
  });
});

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