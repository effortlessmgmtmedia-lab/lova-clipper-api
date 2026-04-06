FROM node:20-slim

# Install ffmpeg, yt-dlp, python3
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && pip3 install --break-system-packages yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/storage/downloads /app/storage/clips

EXPOSE 3000

CMD ["node", "server.js"]
