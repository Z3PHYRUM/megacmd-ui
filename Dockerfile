FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8085
CMD ["node", "server.js"]
