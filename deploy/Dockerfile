FROM node:20-alpine AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html vite.config.ts tsconfig.json postcss.config.js tailwind.config.js ./
COPY public public/
COPY backend/board_game/scanner.html public/board_game/scanner.html
COPY src src/
COPY packages packages/

ARG VITE_BASE_URL=/
ARG VITE_API_URL=/api
ENV VITE_BASE_URL=${VITE_BASE_URL}
ENV VITE_API_URL=${VITE_API_URL}
# Vite + Babylon/Cesium/Three exceeds Node's default ~2GB heap during chunk render
ENV NODE_OPTIONS=--max-old-space-size=8192

RUN pnpm build:deploy

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
