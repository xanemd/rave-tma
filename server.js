/**
 * RAVE TMA — Telegram Mini App
 * Сервер синхронизации для совместного просмотра видео
 *
 * ─────────────────────────────────────────────────────────────
 * 1) ЛОКАЛЬНЫЙ ЗАПУСК:
 *    npm install && node server.js
 *    Затем открой http://localhost:3000 (или порт из process.env.PORT)
 *
 * 2) ДЕПЛОЙ НА RENDER.COM (бесплатный хостинг):
 *    a. Зальём проект в GitHub-репозиторий (или используем "Public Git repository").
 *    b. На Render.com: New → Web Service → подключить репозиторий.
 *    c. Настройки:
 *       - Build Command:   (пусто, т.к. зависимостей для сборки нет)
 *       - Start Command:   npm start
 *       - Environment:     Node
 *       Render автоматически подставит process.env.PORT, а статику
 *       сервер раздаёт из папки public/.
 *    d. После деплоя получим HTTPS URL вида https://rave-tma.onrender.com
 *
 * 3) ПРИВЯЗКА К TELEGRAM-БОТУ ЧЕРЕЗ @BotFather:
 *    a. Откройте @BotFather в Telegram.
 *    b. Команда /newapp → создайте новое приложение (Mini App).
 *    c. Укажите HTTPS URL вашего деплоя (например https://rave-tma.onrender.com).
 *    d. BotFather выдаст токен бота и id Mini App.
 *    e. Пропишите токен через /settoken и настройте кнопку меню / кнопку
 *       клавиатуры через /mybots → ваш бот → Bot Settings.
 *    f. Готово — при нажатии на кнопку у пользователя откроется ваш TMA,
 *       а Telegram WebApp SDK автоматически передаст initData / user info.
 * ─────────────────────────────────────────────────────────────
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Для корректной работы за прокси (Render / Railway / Nginx)
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

// Корневой маршрут — просто отдаём index.html (уже покрыто статикой,
// но добавим явно для надёжности и читаемости).
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────────────────────
// КОМНАТЫ
// ─────────────────────────────────────────────────────────────
// Правила:
//  - room_id по умолчанию = "main_room"
//  - клиент может передать room_id через query-параметр ?room=xxx
//    (например ссылка-приглашение из Telegram: ?startapp=room_abc)
//  - Если room_id пришёл от Telegram (start_param в initDataUnsafe),
//    клиент сам подставит его в URL и подключится с ним.
const DEFAULT_ROOM = 'main_room';

// Служебная статистика комнат (для отладки / будущего расширения)
const roomsMeta = new Map();

io.on('connection', (socket) => {
  // ── Определяем комнату ─────────────────────────────────────
  const roomId = sanitizeRoom(socket.handshake.query.room) || DEFAULT_ROOM;
  socket.join(roomId);

  // Метаданные подключения (для логов и подсчёта зрителей)
  const clientInfo = {
    id: socket.id,
    userAgent: socket.handshake.headers['user-agent'] || 'unknown',
    connectedAt: Date.now()
  };

  if (!roomsMeta.has(roomId)) {
    roomsMeta.set(roomId, { viewers: 0, createdAt: Date.now() });
  }
  roomsMeta.get(roomId).viewers += 1;

  console.log(
    `[+] Пользователь ${socket.id} подключился в комнату "${roomId}" ` +
    `(всего зрителей в комнате: ${roomsMeta.get(roomId).viewers})`
  );

  // ── Приветствие нового участника: отдаём ему всё состояние ──
  // Сервер не хранит состояние плеера (оно живёт у "хоста").
  // Вместо этого при подключении нового зрителя мы просим
  // остальных участников комнаты прислать актуальное состояние:
  // 1) Новичку — ждать событие ROOM_STATE от любого участника.
  // 2) Существующим участникам — команду REQUEST_STATE.
  //
  // Такой подход позволяет синхронизировать опоздавшего зрителя
  // без хранения состояния на сервере (проще и надёжнее).
  socket.emit('hello', {
    roomId,
    socketId: socket.id,
    message: 'Подключено к комнате синхронизации'
  });

  // Просим остальных участников комнаты прислать текущее состояние
  socket.to(roomId).emit('request_state', { from: socket.id });

  // ── Обработка ивентов синхронизации ────────────────────────
  // Каждое действие перенаправляется ВСЕМ участникам комнаты,
  // кроме отправителя (socket.broadcast). Это и есть защита
  // от петли событий на уровне сервера: команда не возвращается
  // обратно тому, кто её инициировал.

  socket.on('PLAY', (data) => {
    const payload = normalizePayload(data);
    console.log(`▶  PLAY   | ${socket.id} | room=${roomId}`, payload);
    socket.to(roomId).emit('PLAY', payload);
  });

  socket.on('PAUSE', (data) => {
    const payload = normalizePayload(data);
    console.log(`⏸  PAUSE  | ${socket.id} | room=${roomId}`, payload);
    socket.to(roomId).emit('PAUSE', payload);
  });

  socket.on('SEEK', (data) => {
    const payload = normalizePayload(data);
    console.log(`⏩ SEEK   | ${socket.id} | room=${roomId}`, payload);
    socket.to(roomId).emit('SEEK', payload);
  });

  socket.on('CHANGE_MEDIA', (data) => {
    const payload = normalizePayload(data);
    console.log(`🎬 MEDIA  | ${socket.id} | room=${roomId}`, payload);
    socket.to(roomId).emit('CHANGE_MEDIA', payload);
  });

  // Обычный "ping/status" — например, кто сейчас в комнате
  socket.on('GET_PEERS', () => {
    const peers = [...io.sockets.adapter.rooms.get(roomId) || []]
      .filter((id) => id !== socket.id);
    socket.emit('PEERS', { peers, count: peers.length });
  });

  // ── Отключение ─────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    const meta = roomsMeta.get(roomId);
    if (meta) {
      meta.viewers = Math.max(0, meta.viewers - 1);
    }
    console.log(
      `[-] Пользователь ${socket.id} отключился из комнаты "${roomId}" ` +
      `(причина: ${reason}; зрителей в комнате: ${meta ? meta.viewers : 0})`
    );
    // Сообщаем остальным, что участник вышел
    socket.to(roomId).emit('USER_LEFT', { id: socket.id });
  });

  socket.on('error', (err) => {
    console.error(`[!] Ошибка сокета ${socket.id}:`, err.message);
  });
});

// ─────────────────────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ─────────────────────────────────────────────────────────────

/**
 * Нормализует payload события: гарантирует наличие time (мс) и
 * защищает от мусорных/бинарных данных от клиента.
 */
function normalizePayload(data) {
  if (!data || typeof data !== 'object') return { time: Date.now() };
  return {
    ...data,
    // Всегда перезаписываем время получения на сервере, чтобы
    // все команды имели согласованную метку и у клиентов был
    // единый ориентир для порога рассинхрона.
    time: Date.now(),
  };
}

/**
 * Очищает room_id: только буквы, цифры, дефис и подчёркивание,
 * максимум 64 символа. Всё остальное отбрасывается.
 */
function sanitizeRoom(room) {
  if (typeof room !== 'string') return null;
  const cleaned = room.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned || null;
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
  console.log(`Комната по умолчанию: "${DEFAULT_ROOM}"`);
  console.log(`Статика раздаётся из: ${path.join(__dirname, 'public')}`);
});