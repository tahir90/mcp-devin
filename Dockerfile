# 1. Use a recent Node image
FROM node:20-alpine

# 2. Copy the repo
WORKDIR /app
COPY . .

# 3. Set up pnpm & install everything
RUN corepack enable && corepack prepare pnpm@9.0.6 --activate \
    && pnpm install --no-frozen-lockfile

# 4. Build TypeScript → JS
RUN pnpm run build

# 5. Run the compiled code
EXPOSE 8080
CMD ["node", "dist/index.js"]
