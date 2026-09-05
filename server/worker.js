/**
 * 旅さき — APIキーを預かるバックエンド（Cloudflare Worker）
 *
 * ブラウザにキーを置かないための、いちばん小さな実装です。
 * やることは3つだけ。
 *
 *   1. 決められた3つの入口だけを受ける
 *   2. キーを付けて Google へ渡す
 *   3. 返ってきたものをそのまま返す
 *
 * 置きかた
 * --------
 *   npm create cloudflare@latest tabisaki-api
 *   （src/index.js をこのファイルの中身に置き換える）
 *   npx wrangler secret put GEMINI_API_KEY
 *   npx wrangler secret put MAPS_API_KEY
 *   npx wrangler deploy
 *
 * そのうえで、js/config.js の PROXY_URL に、出てきたURLを書きます。
 *
 * ALLOW_ORIGIN は必ず自分のサイトに絞ってください。"*" のままだと、
 * 誰のページからでも呼べてしまい、キーを隠した意味がなくなります。
 *
 * ただし、Origin だけでは足りません
 * --------------------------------
 * CORS はブラウザの中でしか効かない約束事です。curl やスクリプトから
 * 直に叩く相手には、何の関係もありません。キーを隠しても、この入口が
 * 誰でも叩ける状態なら、**このプロキシ自体が無料のAPIとして使われます**。
 * 請求は持ち主に来ます。
 *
 * そこで、次の順に落とします。
 *   1. Origin        … ここ以外は 403
 *   2. レート制限     … IPごとに 1分/1時間の上限（Durable Object）
 *   3. 本文の大きさ   … Content-Length と実測の両方で見る
 *   4. 入力の中身     … モデル名・経路の起点終点をここで確かめる
 *   5. タイムアウト   … 上流が返さないときに掴んだままにしない
 */

const ALLOW_ORIGIN = "https://example.com";   // ← 自分のサイトに変えること

/** 1つのIPからの上限。ふつうに旅程を作る人には当たらない値です。 */
const PER_MINUTE = 20;
const PER_HOUR = 200;
/** 本文の上限（バイト）。旅程1回ぶんでも 200KB には届きません。 */
const MAX_BODY = 512 * 1024;
/** 上流を待つ時間。 */
const UPSTREAM_TIMEOUT_MS = 30_000;

const GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

/** 呼ばれてよいモデル。ここに無いものは通しません。 */
const ALLOWED_MODELS = new Set([
  "gemini-3.7-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite",
  "gemini-embedding-001",
]);

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), origin);
    if (request.method !== "POST") return cors(text("POST のみです", 405), origin);
    // Origin が無いものは通しません。
    //
    // ブラウザは、クロスオリジンの POST に必ず Origin を付けます。
    // 付いていないということは、ブラウザから来ていないということです
    // （curl・スクリプト・他のサーバー）。それらは、このサイトの
    // 利用者ではありません。
    //
    // これは認証ではありません。Origin は名乗りにすぎず、直に叩く側は
    // 好きな値を書けます。**次の関門はレート制限**です。ここは
    // 「素通りを1段減らす」ためのものと考えてください。
    // 本気で守るなら、Turnstile か、発行したトークンを足してください。
    if (ALLOW_ORIGIN !== "*" && origin !== ALLOW_ORIGIN) {
      return cors(text("このサイトからは呼べません", 403), origin);
    }

    // レート制限。Cloudflare は本物の接続元を CF-Connecting-IP に入れます
    // （X-Forwarded-For と違い、送り手が偽装できません）。
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const gate = await rateCheck(env, ip);
    if (!gate.ok) {
      return cors(text("呼び出しが多すぎます。しばらく待ってからお試しください。",
                       429, { "Retry-After": String(gate.retryAfter) }), origin);
    }

    // 本文の大きさ。申告（Content-Length）だけを信じません。
    const declared = Number(request.headers.get("Content-Length") ?? 0);
    if (declared > MAX_BODY) return cors(text("本文が大きすぎます", 413), origin);

    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    try {
      if (path.endsWith("/gemini/generate")) {
        return cors(await gemini(request, env, "generateContent"), origin);
      }
      if (path.endsWith("/gemini/embed")) {
        return cors(await gemini(request, env, "embedContent"), origin);
      }
      if (path.endsWith("/routes")) {
        return cors(await routes(request, env), origin);
      }
    } catch (e) {
      // 中で何が起きたかは、そのまま外に出しません
      // （キーやサーバーの事情が漏れます）。
      console.error(e);
      if (e?.code === "TOO_LARGE") return cors(text("本文が大きすぎます", 413), origin);
      if (e?.code === "BAD_BODY") return cors(text("本文を読めません", 400), origin);
      const timedOut = e?.name === "AbortError" || e?.name === "TimeoutError";
      return cors(text(timedOut ? "上流の応答がありませんでした" : "処理できませんでした",
                       timedOut ? 504 : 502), origin);
    }
    return cors(text("その入口はありません", 404), origin);
  },
};

async function gemini(request, env, method) {
  const body = await readJson(request);
  const model = String(body?.model ?? "");
  if (!ALLOWED_MODELS.has(model)) return text("そのモデルは使えません", 400);
  // model はURLに移すので、本文からは外します
  const { model: _drop, ...payload } = body;
  const res = await fetch(
    `${GEMINI_ROOT}/models/${encodeURIComponent(model)}:${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  return passthrough(res);
}

async function routes(request, env) {
  const body = await readJson(request);
  // 起点と終点が無いものを上流に流しても、課金される呼び出しを
  // こちらが肩代わりして失敗させるだけです。
  if (!body?.origin || !body?.destination) {
    return text("経路の起点と終点が必要です", 400);
  }
  // フィールドマスクはブラウザが決めます。長さだけは切ります。
  const mask = (request.headers.get("X-Goog-FieldMask") ?? "").slice(0, 500);
  const res = await fetch(ROUTES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json",
               "X-Goog-Api-Key": env.MAPS_API_KEY,
               "X-Goog-FieldMask": mask },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  return passthrough(res);
}

/**
 * 本文を読みます。Content-Length は申告にすぎないので、実際に読んだ
 * 長さでも測ります。JSON の物体（オブジェクト）以外は受けません。
 */
async function readJson(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) {
    const e = new Error("too large"); e.code = "TOO_LARGE"; throw e;
  }
  let body;
  try { body = JSON.parse(raw); }
  catch { const e = new Error("bad body"); e.code = "BAD_BODY"; throw e; }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const e = new Error("bad body"); e.code = "BAD_BODY"; throw e;
  }
  return body;
}

/**
 * IPごとの回数を、**取りこぼしなく**数えます。
 *
 * KV ではいけない理由
 * ------------------
 * 最初は KV で「読む → +1 → 書く」をしていました。これは数えられません。
 * 同時に来た2本が、どちらも同じ値を読み、どちらも同じ値を書きます。
 *
 *   A: 20 を読む
 *   B: 20 を読む      ← A はまだ書いていない
 *   A: 21 を書く
 *   B: 21 を書く      ← 2回通ったのに 1 しか増えていない
 *
 * 上限20のつもりが、束ねて投げれば何回でも通ります。従量課金の API を
 * 後ろに置いている以上、「だいたい20回」では制限になりません。
 *
 * Durable Object は、1つのIPにつき1つの実体が、1本ずつ順に処理します。
 * 読んでから書くまでのあいだに、別の呼び出しが割り込みません。
 *
 * 置きかた（wrangler.toml）
 *   [[durable_objects.bindings]]
 *   name = "RATE"
 *   class_name = "RateLimiter"
 *
 *   [[migrations]]
 *   tag = "v1"
 *   new_sqlite_classes = ["RateLimiter"]
 *
 * バインドが無いときは通します。設定し忘れで旅程が作れなくなるより、
 * 動くほうを選びます。ただし、そのことをログに出します。
 */
async function rateCheck(env, ip) {
  if (!env.RATE) {
    console.warn("RATE が未バインドです。レート制限は効いていません");
    return { ok: true };
  }
  const id = env.RATE.idFromName(ip);
  const stub = env.RATE.get(id);
  const res = await stub.fetch("https://rate/check");
  return res.json();
}

/**
 * IPごとのカウンタ。1つのIPにつき1つの実体が、1本ずつ順に処理します。
 *
 * 保持するのは「直近1時間の通過時刻」だけです。誰が何をしたかは
 * 持ちません。1時間より古いものは、数えるたびに落とします。
 */
export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch() {
    // blockConcurrencyWhile の中は、この実体で1本ずつ実行されます。
    // 読んでから書くまでのあいだに、別の呼び出しが割り込みません。
    return this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const hits = (await this.state.storage.get("hits")) ?? [];
      const recent = hits.filter((t) => now - t < 3_600_000);
      const lastMinute = recent.filter((t) => now - t < 60_000);

      if (lastMinute.length >= PER_MINUTE) {
        await this.state.storage.put("hits", recent);
        return json({ ok: false, retryAfter: 60 });
      }
      if (recent.length >= PER_HOUR) {
        await this.state.storage.put("hits", recent);
        return json({ ok: false, retryAfter: 600 });
      }
      recent.push(now);
      await this.state.storage.put("hits", recent);
      // 1時間なにも来なければ、この実体ごと消えます。
      await this.state.storage.setAlarm(now + 3_600_000);
      return json({ ok: true });
    });
  }

  /** 誰も来なくなったら、持っているものを捨てます。 */
  async alarm() {
    await this.state.storage.deleteAll();
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj),
    { headers: { "Content-Type": "application/json" } });
}

async function passthrough(res) {
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(message, status, extra = {}) {
  return new Response(JSON.stringify({ error: { message } }),
    { status, headers: { "Content-Type": "application/json", ...extra } });
}

function cors(res, origin) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin",
        ALLOW_ORIGIN === "*" ? (origin || "*") : ALLOW_ORIGIN);
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, X-Goog-FieldMask");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}
