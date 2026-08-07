FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data /app/storage/raw /app/storage/images
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js", "serve"]
