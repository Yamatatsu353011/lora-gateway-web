# lora-gateway-web

LoRa/BST-IDを利用した分散型災害支援システムのWebアプリケーションです。

GPS・LoRaノードの位置表示、支援物資の発注・受注、受領確認などを行います。

LoRa通信は`lora-mesh-daemon`が担当し、本アプリケーションはRedisとSQLiteを介して連携します。

## 1. 開発環境

**ソフトウェア**
- Ubuntu 22.04 / 24.04
- Node.js 22系
- npm
- Python 3
- Redis
- SQLite3
- Git

主なファイル：

| ファイル | 役割 |
|---|---|
| `app.js` | Express Webサーバー |
| `views/` | EJSによる画面表示 |
| `public/` | CSS・静的ファイル |
| `lora_node_sync.py` | RedisからSQLiteへのデータ同期 |
| `sql/` | SQLite関連ファイル |
| `.env` | Webサーバーの環境設定 |

## 2. 環境構築

### 必要なパッケージ

```bash
sudo apt update
sudo apt install -y \
  sqlite3 \
  redis-server \
  python3 \
  python3-venv \
  python3-pip \
  git \
  build-essential
```

Node.jsとnpmは別途インストールしてください。

```bash
node -v
npm -v
```

### リポジトリの取得

```bash
cd /opt

sudo git clone https://github.com/Yamatatsu353011/lora-gateway-web.git

sudo chown -R $USER:$USER /opt/lora-gateway-web
```

### Node.jsライブラリ

```bash
cd /opt/lora-gateway-web

npm install
```

Ubuntu環境で`sqlite3`のネイティブモジュールに関するエラーが発生した場合：

```bash
npm rebuild sqlite3 --build-from-source
```

### Python仮想環境

```bash
cd /opt/lora-gateway-web

python3 -m venv .venv
source .venv/bin/activate

pip install redis
```

## 3. 環境設定

`.env`を作成します。

```bash
cd /opt/lora-gateway-web

nano .env
```

設定例：

```env
PORT=3000
REDIS_URL=redis://127.0.0.1:6379
SQLITE_PATH=/var/lib/lora-gateway/gateway.db
```

### 設定項目

| 項目 | 説明 |
|---|---|
| PORT | Webサーバーのポート番号 |
| REDIS_URL | Redis接続先 |
| SQLITE_PATH | SQLiteデータベースの保存先 |

### ノードIDについて

Web側では、`lora-mesh-daemon`の`config.py`に設定された`OWN_ID`を使用します。

```python
OWN_ID = "0001"
```

`mesh_daemon.py`がRedisに書き込む以下のキーから取得します。

```text
lora:gateway:local_node_id
```

確認：

```bash
redis-cli GET lora:gateway:local_node_id
```

正常であれば`0001`や`0002`が取得できます。

**Web側とLoRa側は、同じRedisのデータを参照できる必要があります。**

WindowsとWSLを併用する場合は、両方が同じRedisインスタンスに接続していることを確認してください。

## 4. SQLite

データベースの保存先：

```text
/var/lib/lora-gateway/gateway.db
```

ディレクトリ作成：

```bash
sudo mkdir -p /var/lib/lora-gateway
sudo chown -R $USER:$USER /var/lib/lora-gateway
```

### データベースの初期化

新規環境では、以下のテーブルなどが必要です。

- `orders`
- `order_items`
- `offers`
- `offer_items`
- `item_master`
- `order_receipts`
- `mobile_nodes`

**注意：現時点のGitHubには、旧READMEに記載されていた`sql/all_schema.sql`と`sql/seed_master.sql`が存在しません。**

新規環境を構築する場合は、既存環境と一致するSQLiteスキーマおよびマスターデータを別途準備する必要があります。

`lora_node_sync.py`は`mobile_nodes`と`order_receipts`のテーブル作成処理を持ちますが、発注機能に必要なすべてのテーブルを作成するわけではありません。

既存DBのテーブル確認：

```bash
sqlite3 /var/lib/lora-gateway/gateway.db ".tables"
```

## 5. 起動方法

WebサーバーとSQLite同期プログラムを、それぞれ起動します。

### Webサーバー

```bash
cd /opt/lora-gateway-web

node app.js
```

アクセス：

```text
http://127.0.0.1:3000/
```

### Redis → SQLite同期

別のターミナルで実行します。

```bash
cd /opt/lora-gateway-web

source .venv/bin/activate

python lora_node_sync.py
```

このプログラムでは、主に以下のデータを同期します。

- LoRaノードの位置情報
- ASKで受信した発注情報
- REPLY(P)で受信した回答情報
- REPLY(C)で受信した受領確認情報

`lora_node_sync.py`内にもRedis接続先とSQLite保存先の設定があります。

Web側の`.env`とは別に、接続先が一致しているか確認してください。

## 6. systemdサービス

サービス登録済みの場合：

```bash
# Webサーバー
sudo systemctl status lora-web.service
sudo systemctl restart lora-web.service

# SQLite同期
sudo systemctl status lora-node-sync.service
sudo systemctl restart lora-node-sync.service
```

ログ確認：

```bash
journalctl -u lora-web.service -f

journalctl -u lora-node-sync.service -f
```

※ 未登録の環境では、サービスファイルの作成が必要です。

## 7. 主な画面

| URL | 機能 |
|---|---|
| `/` | GPSダッシュボード |
| `/mobile` | メニュー画面 |
| `/orders/new` | 新規発注 |
| `/orders` | 発注一覧 |
| `/orders/:orderId` | 発注詳細・受領確認 |
| `/requests` | 受信した発注一覧 |
| `/requests/:orderId/reply` | 受注Reply |
| `/nodes` | モバイルノードマップ |
| `/events` | イベントマップ |

### 発注・受注の通信

```text
基地局A                     基地局B

  Webで発注
      |
      |------ ASK ---------->
      |
      |<----- REPLY(P) ------
      |
  物資受領確認
      |
      |------ REPLY(C) ----->
      |
                          受領完了を記録
```

LoRa通信自体は`lora-mesh-daemon`で処理し、Web側ではRedisとSQLiteを使用して情報を管理します。

## 8. 注意事項

- Redisが起動していることを確認する。
- WebとLoRaデーモンが同じRedisを参照していることを確認する。
- 発注・受注を使用する場合は`mesh_daemon.py`も起動する。
- `lora_node_sync.py`を起動し、SQLiteへの同期を行う。
- SQLiteのテーブルとマスターデータが存在することを確認する。
- `.env`、`node_modules/`、`.venv/`、SQLiteのDBファイルはGit管理しない。

### 関連リポジトリ

**lora-mesh-daemon**

https://github.com/Yamatatsu353011/lora-mesh-daemon

LoRa送受信、ASK/REPLY、Duplicate Suppression、BST-ID指向性転送などを担当します。

## Windows＋WSL環境でのセットアップ

Windows環境ではWSL（Ubuntu）上でWebアプリケーションを実行します。

`lora-mesh-daemon`はWindows側、`lora-gateway-web`はWSL側にインストールします。

### 1. WSLの導入

WindowsのPowerShellを管理者として開きます。

```powershell
wsl --install -d Ubuntu-22.04
```

インストール後、必要に応じて再起動します。

Ubuntuを起動：

```powershell
wsl -d Ubuntu-22.04
```

以降のコマンドは、WSLのUbuntuターミナルで実行します。

### 2. 必要なパッケージ

```bash
sudo apt update

sudo apt install -y \
  git \
  redis-server \
  sqlite3 \
  python3 \
  python3-venv \
  python3-pip \
  build-essential \
  curl
```

Node.jsは22系を使用します。

Node.js 22が導入済みであることを確認してください。

```bash
node -v
npm -v
```

### 3. リポジトリの取得

```bash
cd /opt

sudo git clone https://github.com/Yamatatsu353011/lora-gateway-web.git

sudo chown -R $USER:$USER /opt/lora-gateway-web
```

### 4. Node.js環境

```bash
cd /opt/lora-gateway-web

npm install
```

`sqlite3`のネイティブモジュールでエラーが発生する場合：

```bash
npm rebuild sqlite3 --build-from-source
```

### 5. Python環境

```bash
cd /opt/lora-gateway-web

python3 -m venv .venv
source .venv/bin/activate

pip install redis
```

### 6. Redis

```bash
sudo service redis-server start

redis-cli ping
```

正常時：

```text
PONG
```

### 7. Web設定

```bash
cd /opt/lora-gateway-web

nano .env
```

設定例：

```env
PORT=3000
REDIS_URL=redis://127.0.0.1:6379
SQLITE_PATH=/var/lib/lora-gateway/gateway.db
```

Windows側のLoRaプログラムと同じRedisサーバーを参照してください。

### 8. SQLite

```bash
sudo mkdir -p /var/lib/lora-gateway
sudo chown -R $USER:$USER /var/lib/lora-gateway
```

既存のデータベースがある場合は、テーブルを確認します。

```bash
sqlite3 /var/lib/lora-gateway/gateway.db ".tables"
```

※ 新規環境では発注・受注に必要なテーブルの初期化が必要です。既存DBの構造に対応したSQLを準備してください。

### 9. プログラム起動

WSLのUbuntuターミナルを2つ使用します。

**ターミナル1：Webサーバー**

```bash
cd /opt/lora-gateway-web

node app.js
```

**ターミナル2：SQLite同期**

```bash
cd /opt/lora-gateway-web

source .venv/bin/activate

python lora_node_sync.py
```

### 10. Webアクセス

Windowsのブラウザからアクセスします。

```text
http://localhost:3000/
```

### 注意事項

- `sudo apt`はWSL側で実行します。
- `npm install`もWSL側で実行します。
- RedisとSQLiteはWSL側で管理します。
- Windows側のLoRa通信プログラムとRedisの接続を確認してください。
- WindowsとWSLのPython仮想環境は別々です。
- WSLでインストールしたPythonライブラリは、Windows側のPythonには反映されません。
