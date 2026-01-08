FROM node:20-alpine

# 作業ディレクトリを設定
WORKDIR /app

# package.jsonとpackage-lock.jsonをコピー
COPY package*. json ./

# 依存パッケージをインストール
RUN npm install

# アプリケーションのコードをコピー
COPY . .

# botを起動
CMD ["node", "bot.js"]
