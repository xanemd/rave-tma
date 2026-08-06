# RAVE TMA — Telegram Mini App
# Стандартный Node.js образ с Docker Hub (надёжнее, чем railpack-frontend из ghcr.io)
FROM node:20-alpine

WORKDIR /app

# Копируем package.json и package-lock.json для кэширования слоя зависимостей
COPY package*.json ./

# Устанавливаем только production-зависимости
RUN npm install --omit=dev

# Копируем исходники
COPY . .

# Порт сервера
EXPOSE 3000

# Запуск
CMD ["npm", "start"]