FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 py3-pip ffmpeg && \
    pip3 install --no-cache-dir --break-system-packages yt-dlp
COPY package.json .
RUN npm install
COPY . .
ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8085
CMD ["node", "server.js"]
