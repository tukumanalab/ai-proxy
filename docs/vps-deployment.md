# VPSサーバーへのデプロイガイド

このガイドでは、nginxが稼働しているVPSサーバーにAI Proxyをデプロイする手順を説明します。

## 目次

1. [前提条件](#前提条件)
2. [サーバーの準備](#サーバーの準備)
3. [アプリケーションのデプロイ](#アプリケーションのデプロイ)
4. [PM2でのプロセス管理](#pm2でのプロセス管理)
5. [nginxのリバースプロキシ設定](#nginxのリバースプロキシ設定)

---

## 前提条件

### サーバー要件

- Ubuntu 20.04以上（または同等のLinuxディストリビューション）
- Node.js 20.x LTS以上がインストール済み
- PM2（プロセスマネージャー）がインストール済み
- nginxがインストール済み
- sudo権限を持つユーザーアカウント
- 最低1GB RAM推奨

### ローカル環境

- SSHアクセス権限
- gitがインストール済み

---

## サーバーの準備

### 1. アプリケーション用ディレクトリの作成

```bash
sudo mkdir -p /srv/ai-proxy
sudo chown $USER:www-data /srv/ai-proxy
```

---

## アプリケーションのデプロイ

### 1. Gitリポジトリのクローン

```bash
cd /srv/ai-proxy
git clone https://github.com/tukumanalab/ai-proxy.git .
```

### 2. 依存関係のインストール

```bash
cd /srv/ai-proxy
npm install
```

### 3. 環境変数の設定

```bash
# .envファイルを作成
cp .env.example .env

# .envファイルを編集
nano .env
```

`.env`ファイルの設定例：

```bash
# サーバーポート（nginxでリバースプロキシするため、内部ポートを使用）
PORT=4000

# さくらのAI APIエンドポイント
SAKURA_AI_API=https://api.sakura.ai/v1

# データベースパス
DB_PATH=./proxy.db

# NGワード設定（オプション）
NG_WORDS=暴力,違法,詐欺
```

### 4. アプリケーションのビルド

```bash
npm run build
```

### 5. ファイアウォール設定

```bash
# UFWを使用している場合
sudo ufw allow 4000/tcp
sudo ufw allow 'Nginx Full'
sudo ufw status
```

---

## PM2でのプロセス管理

### 1. PM2でアプリケーションを起動

```bash
cd /srv/ai-proxy
pm2 start dist/index.js --name ai-proxy
```

### 2. PM2の便利なコマンド

```bash
# アプリケーションの状態確認
pm2 status

# ログの確認
pm2 logs ai-proxy

# リアルタイムモニタリング
pm2 monit

# アプリケーションの再起動
pm2 restart ai-proxy

# アプリケーションの停止
pm2 stop ai-proxy

# アプリケーションの削除
pm2 delete ai-proxy
```

### 3. 自動起動の設定

```bash
# PM2をシステム起動時に自動起動
pm2 startup systemd

# 上記コマンドの出力に従ってコマンドを実行（例）
# sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u $USER --hp /home/$USER

# 現在のプロセスを保存
pm2 save
```

### 4. アプリケーションの更新手順

```bash
cd /srv/ai-proxy

# 最新のコードを取得
git pull origin main

# 依存関係の更新
npm install

# 再ビルド
npm run build

# PM2でアプリケーションを再起動
pm2 restart ai-proxy
```

---

## nginxのリバースプロキシ設定

### 1. nginxの設定ファイルを作成

```bash
sudo nano /etc/nginx/sites-available/ai-proxy
```

以下の内容を記述：

```nginx
server {
    listen 80;
    server_name your-domain.com;  # ドメイン名に変更

    # ログ設定
    access_log /var/log/nginx/ai-proxy-access.log;
    error_log /var/log/nginx/ai-proxy-error.log;

    # クライアントボディサイズの上限を設定（大きなリクエストに対応）
    client_max_body_size 10M;

    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;

        # WebSocketサポート
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';

        # プロキシヘッダー
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # タイムアウト設定
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        # キャッシュ無効化
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 2. 設定ファイルを有効化

```bash
# シンボリックリンクを作成
sudo ln -s /etc/nginx/sites-available/ai-proxy /etc/nginx/sites-enabled/

# nginx設定のテスト
sudo nginx -t

# nginxを再起動
sudo systemctl restart nginx
```

### 3. 設定の確認

```bash
# nginxのステータス確認
sudo systemctl status nginx

# ブラウザまたはcurlでアクセス確認
curl http://your-domain.com/health
```
