# APIキーをブラウザに置かない

`js/config.js` にキーを書くと、**ページを開いた人から見えます**。
ブラウザから直接 Google を呼ぶ以上、避けられません。

個人利用や localhost ならそのままで構いません。公開サイトにするなら、
自分のバックエンドを1枚挟んでください。

```
ブラウザ（キーを持たない）
   ↓  POST {PROXY_URL}/gemini/generate
   ↓  POST {PROXY_URL}/gemini/embed
   ↓  POST {PROXY_URL}/routes
自分のサーバー（キーはここだけ）
   ↓
Gemini / Routes API
```

## 使いかた

1. `worker.js`（Cloudflare Worker）か `node-proxy.mjs`（Node）を置く
2. キーを環境変数／シークレットで渡す
3. `js/config.js` の `PROXY_URL` にその入口を書く

```js
export const PROXY_URL = "https://tabisaki-api.example.workers.dev";
export const GEMINI_API_KEY = "";   // ← 空のままにします
export const MAPS_API_KEY   = "";   // ← 空のままにします
```

これだけで、`js/endpoints.js` が行き先を切り替え、**キーをヘッダーに
載せなくなります**。アプリ側のコードはほかに何も変わりません。

### Cloudflare Worker

```bash
npm create cloudflare@latest tabisaki-api
# src/index.js を server/worker.js の中身に置き換える
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put MAPS_API_KEY
npx wrangler deploy
```

### Node

```bash
GEMINI_API_KEY=xxx MAPS_API_KEY=yyy \
ALLOW_ORIGIN=https://example.com \
node server/node-proxy.mjs
```

本番では前に TLS を置いてください（Nginx / Caddy など）。
`PROXY_URL` は **https しか受け付けません**。http だと通信の中身が
途中で読まれ、キーを隠した意味がなくなるためです。

## 必ずやること

| 設定 | なぜ |
|---|---|
| `ALLOW_ORIGIN` を自分のサイトに絞る | `*` のままだと誰のページからでも呼べ、キーを隠した意味がなくなります |
| 呼べるモデルを絞る（`ALLOWED_MODELS`） | 高いモデルを勝手に呼ばれるのを防ぎます |
| Google 側でもキーを制限する | 万一漏れたときの被害を小さくします |

## レート制限

IPごとに **20回/分・200回/時**（既定）で切ります。

### Cloudflare は Durable Object を使ってください

`wrangler.toml`（雛形を同梱）に、次が要ります。

```toml
[[durable_objects.bindings]]
name = "RATE"
class_name = "RateLimiter"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RateLimiter"]
```

**KV ではいけません。** KV で「読む → +1 → 書く」をすると、
同時に来た2本が同じ値を読み、同じ値を書きます。

```
A: 20 を読む
B: 20 を読む      ← A はまだ書いていない
A: 21 を書く
B: 21 を書く      ← 2回通ったのに 1 しか増えていない
```

上限20のつもりが、束ねて投げれば何回でも通ります。従量課金の API を
後ろに置いている以上、「だいたい20回」では制限になりません。
Durable Object なら、1つのIPにつき1つの実体が1本ずつ処理します。

バインドを忘れると**制限なしで通します**（設定し忘れで旅程が作れなく
なるより動くほうを選んでいます）。そのことはログに出ます。

### 二重にかける

上の制限は「Worker に届いてから」効きます。届く前に落としたいなら、
ダッシュボードの Security → WAF → Rate limiting rules でも同じパスに
上限をかけてください。二重にして損はありません。

## Origin だけでは足りない

Origin が無いリクエストは弾きます。ブラウザはクロスオリジンの POST に
必ず Origin を付けるので、付いていないものはブラウザから来ていません。

ただし **これは認証ではありません。** Origin は名乗りにすぎず、直に
叩く側は好きな値を書けます。素通りを1段減らすだけのものです。

## まだやっていないこと

公開の規模によっては、次が要ります。

| | なぜ |
|---|---|
| Turnstile（またはトークン発行） | 「このAPIを叩いているのは誰か」を、名乗り以外で確かめるため |
| 利用者ごとの上限 | IPは共有されます（社内・キャリアNAT・VPN） |
| 使用量の記録 | 誰の何が高いのかは、記録が無いと分かりません |
| Google 側のキー制限 | 万一漏れたときの被害を小さくします |

アプリ側の使用量ゲート（`js/quota.js`、50件ごとの確認）は
**その端末の中でしか数えていません**。サーバー側の上限の代わりには
なりません。
