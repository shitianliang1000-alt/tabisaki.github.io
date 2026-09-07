const ALLOW_ORIGIN = "https://shitianliang1000-alt.github.io";
const PER_MINUTE = 20;
const PER_HOUR = 200;
const MAX_BODY = 512 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const YAHOO_TRANSIT_URL = "https://transit.yahoo.co.jp/search/result";
const ALLOWED_MODELS = new Set([
  "gemini-3.7-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite",
  "gemini-embedding-001",
]);

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), origin);
    if (request.method !== "POST") return cors(text("POST のみです", 405), origin);
    if (ALLOW_ORIGIN !== "*" && origin !== ALLOW_ORIGIN) {
      return cors(text("このサイトからは呼べません", 403), origin);
    }

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const gate = await rateCheck(env, ip);
    if (!gate.ok) {
      return cors(text("呼び出しが多すぎます。しばらく待ってからお試しください。", 429,
        { "Retry-After": String(gate.retryAfter) }), origin);
    }

    const declared = Number(request.headers.get("Content-Length") ?? 0);
    if (declared > MAX_BODY) return cors(text("本文が大きすぎます", 413), origin);

    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    try {
      if (path.endsWith("/gemini/generate")) return cors(await gemini(request, env, "generateContent"), origin);
      if (path.endsWith("/gemini/embed")) return cors(await gemini(request, env, "embedContent"), origin);
      if (path.endsWith("/routes")) return cors(await routes(request, env), origin);
      if (path.endsWith("/yahoo/transit")) return cors(await yahooTransit(request), origin);
    } catch (e) {
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
  const { model: _drop, ...payload } = body;
  const res = await fetch(`${GEMINI_ROOT}/models/${encodeURIComponent(model)}:${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  return passthrough(res);
}

async function yahooTransit(request) {
  const body = await readJson(request);
  const from = String(body?.from ?? "").trim();
  const to = String(body?.to ?? "").trim();
  if (!from || !to || from.length > 100 || to.length > 100) {
    return text("出発地と到着地が必要です", 400);
  }

  const u = new URL(YAHOO_TRANSIT_URL);
  u.searchParams.set("from", from);
  u.searchParams.set("to", to);
  u.searchParams.set("shin", "1");
  u.searchParams.set("ex", "1");
  u.searchParams.set("al", "1");
  u.searchParams.set("s", "0");
  u.searchParams.set("all", "1");
  u.searchParams.set("type", "1");

  if (body?.departAt) {
    const d = new Date(body.departAt);
    if (!Number.isNaN(d.getTime())) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(d);
      const get = (name) => parts.find((x) => x.type === name)?.value ?? "";
      const hh = get("hour") === "24" ? "00" : get("hour");
      u.searchParams.set("dispDate", `${get("year")}${get("month")}${get("day")}${hh}${get("minute")}`);
    }
  }

  const res = await fetch(u, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; TabisakiTransit/1.0)",
      "Accept-Language": "ja-JP,ja;q=0.9",
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) return text(`Yahoo Transit ${res.status}`, 502);

  const html = await res.text();
  const route = html.match(/id=["']route01["'][\s\S]*?<\/div>\s*<\/div>/i)?.[0] ?? html;
  const plain = route.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const time = plain.match(/(\d{1,2}:\d{2})\s*(?:発|出発)?[^0-9]{0,80}?(\d{1,2}:\d{2})\s*(?:着|到着)?/);
  if (!time) return json({ routed: false, url: u.toString(), reason: "Yahoo!路線情報の経路結果を取得できませんでした" });

  const [h1, m1] = time[1].split(":").map(Number);
  const [h2, m2] = time[2].split(":").map(Number);
  let minutes = (h2 * 60 + m2) - (h1 * 60 + m1);
  if (minutes < 0) minutes += 1440;
  if (minutes <= 0 || minutes > 1440) return json({ routed: false, url: u.toString() });

  return json({ routed: true, minutes, summary: plain.slice(0, 500),
    meta: { url: u.toString(), departure: time[1], arrival: time[2] } });
}

async function routes(request, env) {
  const body = await readJson(request);
  if (!body?.origin || !body?.destination) return text("経路の起点と終点が必要です", 400);
  const mask = (request.headers.get("X-Goog-FieldMask") ?? "").slice(0, 500);
  const res = await fetch(ROUTES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": env.MAPS_API_KEY,
      "X-Goog-FieldMask": mask },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  return passthrough(res);
}

async function readJson(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) { const e = new Error("too large"); e.code = "TOO_LARGE"; throw e; }
  let body;
  try { body = JSON.parse(raw); } catch { const e = new Error("bad body"); e.code = "BAD_BODY"; throw e; }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const e = new Error("bad body"); e.code = "BAD_BODY"; throw e;
  }
  return body;
}

async function rateCheck(env, ip) {
  if (!env.RATE) return { ok: true };
  const id = env.RATE.idFromName(ip);
  const stub = env.RATE.get(id);
  const res = await stub.fetch("https://rate/check");
  return res.json();
}

export class RateLimiter {
  constructor(state) { this.state = state; }
  async fetch() {
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
      await this.state.storage.setAlarm(now + 3_600_000);
      return json({ ok: true });
    });
  }
  async alarm() { await this.state.storage.deleteAll(); }
}

function json(obj) {
  return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } });
}
async function passthrough(res) {
  return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
}
function text(message, status, extra = {}) {
  return new Response(JSON.stringify({ error: { message } }),
    { status, headers: { "Content-Type": "application/json", ...extra } });
}
function cors(res, origin) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", ALLOW_ORIGIN === "*" ? (origin || "*") : ALLOW_ORIGIN);
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, X-Goog-FieldMask");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}
