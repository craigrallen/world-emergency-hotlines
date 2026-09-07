# Payments foundation — separate Railway service. Build context is `payments/`
# (set the Railway service root directory to `payments`). Not deployed today.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY contracts/ ./contracts/
ENV NODE_ENV=production PAYMENTS_MODE=disabled PAYMENTS_HOST=:: PORT=8081 PAYMENTS_TRUST_PROXY=1
USER node
EXPOSE 8081
CMD ["node", "src/cli.mjs", "serve"]
