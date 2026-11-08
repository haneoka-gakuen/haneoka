FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY main.mjs ./main.mjs
USER node
EXPOSE 8090
CMD ["node", "main.mjs"]
