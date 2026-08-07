FROM node:20-bookworm-slim

WORKDIR /app

# Install production dependencies before source files to improve Docker caching.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p /app/storage/raw /app/storage/images

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js", "serve"]
