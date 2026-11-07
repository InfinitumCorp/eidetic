FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
COPY apps/admin ./apps/admin
COPY apps/reviewer/package.json ./apps/reviewer/package.json
COPY apps/api/package.json ./apps/api/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @eidetic/admin build

FROM nginx:1.27-alpine
COPY apps/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
