FROM node:24-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --omit=optional

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
EXPOSE 8080
CMD ["npm", "start"]
