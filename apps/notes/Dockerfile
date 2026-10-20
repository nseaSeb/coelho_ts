# Built from the repository root: docker compose up, or
#   docker build -f apps/notes/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "coelho-notes..."
RUN pnpm --filter "./packages/*" build && pnpm --filter coelho-notes build
# Only what the server needs at run time: its production dependencies,
# the workspace packages it uses as built, and the built app.
RUN pnpm --filter coelho-notes deploy --prod --legacy /out && cp -r apps/notes/dist /out/dist

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /out .
EXPOSE 8080
USER node
CMD ["node", "dist/server/main.js"]
