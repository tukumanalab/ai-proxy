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
vi .env
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

サーバー再起動時にAI Proxyが自動的に起動するように設定します。

```bash
# ステップ1: PM2の自動起動設定コマンドを生成
pm2 startup systemd
```

上記コマンドを実行すると、以下のような **sudoコマンドが表示** されます：

```
[PM2] You have to run this command as root. Execute the following command:
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u username --hp /home/username
```

**表示されたsudoコマンドをコピーして実行してください：**

```bash
# ステップ2: 表示されたコマンドを実行（コマンドは環境によって異なります）
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u $USER --hp /home/$USER
```

```bash
# ステップ3: 現在のプロセスリストを保存
pm2 save
```

これで、サーバー再起動後も自動的にAI Proxyが起動します。

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

`include` ディレクティブを使って、既存のnginx設定に `location` ブロックを追加します。

### 1. location専用の設定ファイルを作成

```bash
sudo vi /etc/nginx/conf.d/ai-proxy-location.conf
```

以下の内容を記述（`location` ブロックのみ）：

```nginx
location /ai-proxy/ {
    # AIリクエスト用に大きなボディサイズを許可
    client_max_body_size 10M;

    # パスをリライト（/ai-proxy/xxx を /xxx に変換）
    rewrite ^/ai-proxy/(.*)$ /$1 break;

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
```

### 2. 既存の設定ファイルに include を追加

既存のnginx設定ファイル（例: `/etc/nginx/sites-available/default`）を編集：

```bash
sudo vi /etc/nginx/sites-available/default
```

`server` ブロック内に以下を追加：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # 既存の設定...

    # AI Proxyの設定を読み込み
    include /etc/nginx/conf.d/ai-proxy-location.conf;
}
```

### 3. 設定のテストと反映

```bash
# nginx設定のテスト
sudo nginx -t

# nginxを再起動
sudo systemctl restart nginx
```

### 4. 設定の確認

```bash
# nginxのステータス確認
sudo systemctl status nginx

# ブラウザまたはcurlでアクセス確認
curl http://your-domain.com/ai-proxy/health
```

**アクセスURL:**
- ダッシュボード: `http://your-domain.com/ai-proxy/`
- プロキシエンドポイント: `http://your-domain.com/ai-proxy/proxy`
- ヘルスチェック: `http://your-domain.com/ai-proxy/health`
