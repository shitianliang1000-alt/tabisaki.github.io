const ALLOW_ORIGIN = "https://shitianliang1000-alt.github.io";
const PER_MINUTE = 20;
const PER_HOUR = 200;
const MAX_BODY = 512 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const YAHOO_TRANSIT_URL = "https://transit.yahoo.co.jp/search/print";
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
    if (!gate.ok) return cors(text("呼び出しが多すぎます。しばらく待ってからお試しください。", 429,
      { "Retry-After": String(gate.retryAfter) }), origin);
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
      return cors(text(timedOut ? "上流の応答がありませんでした" : "処理できませんでした", timedOut ? 504 : 502), origin);
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
    body: JSON.stringify(payload), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  return passthrough(res);
}

async function yahooTransit(request) {
  const body = await readJson(request);
  const from = String(body?.from ?? "").trim();
  const to = String(body?.to ?? "").trim();
  if (!from || !to || from.length > 100 || to.length > 100) return text("出発地と到着地が必要です", 400);

  const requested = body?.departAt ? new Date(body.departAt) : new Date();
  if (Number.isNaN(requested.getTime())) return text("出発時刻が不正です", 400);

  const p = tokyoParts(requested);
  const u = new URL(YAHOO_TRANSIT_URL);
  u.searchParams.set("from", from);
  u.searchParams.set("flatlon", "");
  u.searchParams.set("to", to);
  u.searchParams.set("y", p.year);
  u.searchParams.set("m", p.month);
  u.searchParams.set("d", p.day);
  u.searchParams.set("hh", p.hour);
  u.searchParams.set("m1", p.minute.slice(0, 1));
  u.searchParams.set("m2", p.minute.slice(1));
  u.searchParams.set("type", "1");
  u.searchParams.set("ticket", "ic");
  u.searchParams.set("expkind", "1");
  u.searchParams.set("userpass", "1");
  u.searchParams.set("ws", "3");
  u.searchParams.set("s", "0");
  u.searchParams.set("al", "1");
  u.searchParams.set("shin", "1");
  u.searchParams.set("ex", "1");
  u.searchParams.set("hb", "1");
  u.searchParams.set("lb", "1");
  u.searchParams.set("sr", "1");

  const res = await fetch(u, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; TabisakiTransit/1.0)",
      "Accept-Language": "ja-JP,ja;q=0.9",
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) return text(`Yahoo Transit ${res.status}`, 502);

  const html = await res.text();
  const route = firstYahooRoute(html);
  const summary = parseSummary(route);
  const detail = parseRouteDetail(route);
  if (!detail.departure || !detail.arrival) {
    return json({ routed: false, url: u.toString(), reason: "Yahoo!路線情報の経路詳細を取得できませんでした" });
  }

  const departure = detail.departure;
  const arrival = detail.arrival;
  const rideMinutes = clockDiff(departure, arrival);
  const requestedMinutes = tokyoClockMinutes(requested);
  const waitMinutes = (clockMinutes(departure) - requestedMinutes + 1440) % 1440;
  const minutes = waitMinutes + rideMinutes;

  return json({
    routed: true,
    minutes,
    rideMinutes,
    waitMinutes,
    summary: summary.text,
    meta: {
      url: u.toString(),
      departure,
      arrival,
      requestedDeparture: requested.toISOString(),
      transfers: summary.transfers,
      fareYen: summary.fareYen,
      distanceKm: summary.distanceKm,
      legs: detail.legs,
      intermediateStops: detail.intermediateStops,
    },
  });
}

function firstYahooRoute(html) {
  const start = html.search(/id=["']route01["']/i);
  if (start < 0) return html;
  const rest = html.slice(start);
  const next = rest.search(/id=["']route02["']/i);
  return next > 0 ? rest.slice(0, next) : rest.slice(0, 400000);
}

function parseSummary(html) {
  const box = html.match(/class=["'][^"']*routeSummary[^"']*["'][\s\S]{0,20000}/i)?.[0] ?? "";
  const time = cleanText(firstMatch(box, /class=["'][^"']*time[^"']*["'][^>]*>([\s\S]*?)<\/li>/i));
  const transferText = cleanText(firstMatch(box, /class=["'][^"']*transfer[^"']*["'][^>]*>([\s\S]*?)<\/li>/i));
  const fareText = cleanText(firstMatch(box, /class=["'][^"']*fare[^"']*["'][^>]*>([\s\S]*?)<\/li>/i));
  const distanceText = cleanText(firstMatch(box, /class=["'][^"']*distance[^"']*["'][^>]*>([\s\S]*?)<\/li>/i));
  const transfers = Number(transferText.match(/(\d+)/)?.[1] ?? 0);
  const fareYen = Number((fareText.match(/([\d,]+)\s*円/)?.[1] ?? "0").replace(/,/g, "")) || null;
  const distanceKm = Number((distanceText.match(/([\d.]+)km/)?.[1] ?? "0")) || null;
  return { text: [time, transferText, fareText, distanceText].filter(Boolean).join(" / "), transfers, fareYen, distanceKm };
}

function parseRouteDetail(html) {
  const detail = html.match(/<div[^>]*class=["'][^"']*routeDetail[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]*class=["'][^"']*routeDetail|<\/div>\s*<\/div>\s*<\/div>)/i)?.[1] ?? html;
  const stations = [];
  const stationRe = /<div[^>]*class=["'][^"']*station[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class=["'][^"']*station|<div[^>]*class=["'][^"']*transport|$)/gi;
  let sm;
  while ((sm = stationRe.exec(detail))) {
    const block = sm[1];
    const name = cleanText(firstMatch(block, /<dt[^>]*>([\s\S]*?)<\/dt>/i));
    const times = [...block.matchAll(/<li[^>]*>(\d{1,2}:\d{2})<\/li>/gi)].map((m) => m[1]);
    if (name) stations.push({ name, times });
  }

  const transports = [];
  const transportRe = /<li[^>]*class=["'][^"']*transport[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let tm;
  while ((tm = transportRe.exec(detail))) {
    const text = cleanText(tm[1]);
    if (text) transports.push(text.replace(/^\[?train\]?\s*/i, ""));
  }

  // 現行Yahoo!のHTMLでは station / transport が交互に並ぶため、
  // station数とtransport数から各乗車区間を組み立てます。
  const legs = [];
  for (let i = 0; i < transports.length && i + 1 < stations.length; i++) {
    const from = stations[i];
    const to = stations[i + 1];
    const dep = from.times[from.times.length - 1] ?? null;
    const arr = to.times[0] ?? null;
    legs.push({
      kind: "ride",
      from: from.name,
      to: to.name,
      departure: dep,
      arrival: arr,
      minutes: dep && arr ? clockDiff(dep, arr) : null,
      line: transports[i],
    });
  }

  const allTimes = [...html.matchAll(/(?:^|[^0-9])([01]?\d|2[0-3]):([0-5]\d)(?![0-9])/g)]
    .map((m) => `${m[1].padStart(2, "0")}:${m[2]}`);
  const departure = stations[0]?.times[0] ?? allTimes[0] ?? null;
  const arrival = stations.at(-1)?.times.at(-1) ?? allTimes.at(-1) ?? null;
  const intermediateStops = stations.slice(1, -1).map((s) => ({
    station: s.name,
    arrival: s.times[0] ?? null,
    departure: s.times[1] ?? null,
  }));
  return { departure, arrival, legs, intermediateStops };
}

function firstMatch(s, re) { return s.match(re)?.[1] ?? ""; }
function cleanText(s) {
  return String(s ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&#39;|&#x27;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ").trim();
}
function tokyoParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (name) => parts.find((x) => x.type === name)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") === "24" ? "00" : get("hour"), minute: get("minute") };
}
function clockMinutes(hm) { const [h, m] = hm.split(":").map(Number); return h * 60 + m; }
function clockDiff(from, to) { return (clockMinutes(to) - clockMinutes(from) + 1440) % 1440; }
function tokyoClockMinutes(date) { const p = tokyoParts(date); return Number(p.hour) * 60 + Number(p.minute); }

async function routes(request, env) {
  const body = await readJson(request);
  if (!body?.origin || !body?.destination) return text("経路の起点と終点が必要です", 400);
  const mask = (request.headers.get("X-Goog-FieldMask") ?? "").slice(0, 500);
  const res = await fetch(ROUTES_URL, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": env.MAPS_API_KEY, "X-Goog-FieldMask": mask },
    body: JSON.stringify(body), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  return passthrough(res);
}
async function readJson(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) { const e = new Error("too large"); e.code = "TOO_LARGE"; throw e; }
  let body; try { body = JSON.parse(raw); } catch { const e = new Error("bad body"); e.code = "BAD_BODY"; throw e; }
  if (!body || typeof body !== "object" || Array.isArray(body)) { const e = new Error("bad body"); e.code = "BAD_BODY"; throw e; }
  return body;
}
async function rateCheck(env, ip) {
  if (!env.RATE) return { ok: true };
  const id = env.RATE.idFromName(ip); const stub = env.RATE.get(id);
  return (await stub.fetch("https://rate/check")).json();
}
export class RateLimiter {
  constructor(state) { this.state = state; }
  async fetch() { return this.state.blockConcurrencyWhile(async () => {
    const now = Date.now(); const hits = (await this.state.storage.get("hits")) ?? [];
    const recent = hits.filter((t) => now - t < 3_600_000); const lastMinute = recent.filter((t) => now - t < 60_000);
    if (lastMinute.length >= PER_MINUTE) { await this.state.storage.put("hits", recent); return json({ ok: false, retryAfter: 60 }); }
    if (recent.length >= PER_HOUR) { await this.state.storage.put("hits", recent); return json({ ok: false, retryAfter: 600 }); }
    recent.push(now); await this.state.storage.put("hits", recent); await this.state.storage.setAlarm(now + 3_600_000); return json({ ok: true });
  }); }
  async alarm() { await this.state.storage.deleteAll(); }
}
function json(obj) { return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } }); }
async function passthrough(res) { return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } }); }
function text(message, status, extra = {}) { return new Response(JSON.stringify({ error: { message } }), { status, headers: { "Content-Type": "application/json", ...extra } }); }
function cors(res, origin) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", ALLOW_ORIGIN === "*" ? (origin || "*") : ALLOW_ORIGIN);
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS"); h.set("Access-Control-Allow-Headers", "Content-Type, X-Goog-FieldMask");
  h.set("X-Content-Type-Options", "nosniff"); h.set("X-Frame-Options", "DENY"); h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains"); h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}
