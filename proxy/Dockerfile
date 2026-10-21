# Build aus dem Projektordner (eine Ebene über proxy/):
#   docker build -f proxy/Dockerfile -t kabeltv-proxy .
FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY proxy/package.json proxy/server.js proxy/epg.js ./
COPY webos-app ./public

ENV PORT=8095 \
    FRITZ_HOST=192.168.177.1 \
    TZ=Europe/Berlin \
    STATIC_DIR=/app/public \
    WORK_DIR=/tmp/kabeltv

EXPOSE 8095
CMD ["node", "server.js"]
