FROM oven/bun:1.3.13-debian AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run devops/copy-rdkit.ts && bun next build

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
COPY --from=build /app/out /usr/share/nginx/html
EXPOSE 8080
