FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --config.confirmModulesPurge=false
COPY . .
ENV PORT=3010
EXPOSE 3010
VOLUME ["/app/data"]
CMD ["pnpm","start"]
