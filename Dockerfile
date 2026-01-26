FROM node:20-slim

WORKDIR /app

# better-sqlite3 ビルド用ツールインストール→キャッシュ削除
RUN apt-get update && \
    apt-get install -y python3 make g++ build-essential && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# 依存関係インストール
RUN npm ci --omit=dev

# ソースコードをコピー
COPY . .

# 実行
CMD ["node", "bot.js"]