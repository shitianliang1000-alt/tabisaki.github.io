// 呼び出しを許すページの出どころ。
//
// Worker の変数 ALLOW_ORIGIN で上書きできます（カンマ区切りで複数）。
// ここを直に書き換えると、公開先を増やすたびに Worker を作り直すことに
// なります。手元で開発するときは、次のように足してください。
//
//   npx wrangler secret put ALLOW_ORIGIN
//   https://shitianliang1000-alt.github.io,http://localhost:8000
const DEFAULT_ALLOW_ORIGIN = "https://shitianliang1000-alt.github.io";

function allowList(env) {
  const raw = String(env?.ALLOW_ORIGIN ?? "").trim();
  return (raw || DEFAULT_ALLOW_ORIGIN).split(/[,\s]+/).filter(Boolean);
}
const PER_MINUTE = 20;
const PER_HOUR = 200;
const MAX_BODY = 512 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
// 検索結果のページを読みます。印刷用（/search/print）は1本しか載って
// いません。Yahoo!は候補を3本出す（早い順・安い順・乗換の少ない順）ので、
// 全部読んで、選べるようにします。
const YAHOO_TRANSIT_URL = "https://transit.yahoo.co.jp/search/result";
// 中継が通すモデル。ここに無いものは 400 で返します（高いモデルを
// 勝手に呼ばれないため）。埋め込みは Gemma に無いので Gemini のままです。
// Cloudflare の Workers AI で動かすモデル。**Googleのキーは要りません。**
// 中継（このWorker）の中で走ります。E2B は Workers AI には無いので、
// Gemma 4 のうち配信されているものを使います。
const ALLOWED_CF_MODELS = new Set([
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/zai-org/glm-4.7-flash",
]);

const ALLOWED_MODELS = new Set([
  "gemma-4-e2b-it", "gemma-4-26b-a4b-it", "gemma-4-31b-it",
  "gemma-3-27b-it", "gemma-3-12b-it", "gemma-3-4b-it",
  "gemini-3.7-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite",
  "gemini-embedding-001",
]);

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";
    const allow = allowList(env);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), origin, allow);
    if (request.method !== "POST") return cors(text("POST のみです", 405), origin, allow);
    if (!allow.includes("*") && !allow.includes(origin)) {
      // 断るときも、返事は読めるようにします。CORSの見出しを付けないと、
      // ブラウザは中身を捨てて「Load failed」とだけ言います。何が起きたか
      // 分からないまま「中継の設定を確認してください」と出ていました。
      // 中身は断り文句だけなので、出どころをそのまま返して差し支えありません。
      return cors(text(`このサイト（${origin || "出どころ不明"}）からは呼べません。`
        + "Worker の ALLOW_ORIGIN に、このアドレスを足してください", 403),
        origin, ["*"]);
    }
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const gate = await rateCheck(env, ip);
    if (!gate.ok) return cors(text("呼び出しが多すぎます。しばらく待ってからお試しください。", 429,
      { "Retry-After": String(gate.retryAfter) }), origin, allow);
    const declared = Number(request.headers.get("Content-Length") ?? 0);
    if (declared > MAX_BODY) return cors(text("本文が大きすぎます", 413), origin, allow);
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    try {
      if (path.endsWith("/gemini/generate")) return cors(await gemini(request, env, "generateContent"), origin, allow);
      if (path.endsWith("/gemini/embed")) return cors(await gemini(request, env, "embedContent"), origin, allow);
      if (path.endsWith("/routes")) return cors(await routes(request, env), origin, allow);
      if (path.endsWith("/cf/generate")) return cors(await cfGenerate(request, env), origin, allow);
      if (path.endsWith("/yahoo/transit")) return cors(await yahooTransit(request), origin, allow);
      // 鍵が入っているかどうかだけを答えます（値は返しません）。
      // 「キーが無効です」と「中継に鍵が置かれていない」は別のことで、
      // 直す場所も違います。画面がそれを言い分けられるようにします。
      if (path.endsWith("/status")) {
        return cors(json({
          ok: true,
          secrets: {
            MAPS_API_KEY: hasSecret(env, "MAPS_API_KEY"),
            GEMINI_API_KEY: hasSecret(env, "GEMINI_API_KEY"),
          },
          // Workers AI が使えるなら、AIのキーは要りません。
          workersAi: Boolean(env.AI),
          allowOrigin: allow,
        }), origin, allow);
      }
    } catch (e) {
      console.error(e);
      if (e?.code === "TOO_LARGE") return cors(text("本文が大きすぎます", 413), origin, allow);
      if (e?.code === "BAD_BODY") return cors(text("本文を読めません", 400), origin, allow);
      const timedOut = e?.name === "AbortError" || e?.name === "TimeoutError";
      return cors(text(timedOut ? "上流の応答がありませんでした" : "処理できませんでした", timedOut ? 504 : 502), origin, allow);
    }
    return cors(text("その入口はありません", 404), origin, allow);
  },
};

/** 鍵が入っているか（値は見せません）。 */
function hasSecret(env, name) {
  return typeof env?.[name] === "string" && env[name].trim().length > 0;
}

/** 鍵が無いときの返事。無ければ null。 */
function missingSecret(env, name) {
  if (hasSecret(env, name)) return null;
  return text(`中継に ${name} が設定されていません。`
    + "Cloudflare のダッシュボードで、Workers & Pages → この Worker → "
    + `Settings → **Runtime** の Variables and Secrets に、Secret として ${name} を`
    + "足してください（Builds の欄ではありません。あちらはビルド中だけの値で、"
    + "動いている Worker からは見えません）。"
    + `コマンドなら \`npx wrangler secret put ${name}\` です`, 503);
}

/**
 * Cloudflare の Workers AI で答えさせます。
 *
 * Googleのキーは要りません。Cloudflare のアカウントの中で走るので、
 * 鍵を置き忘れて「API key not valid」になることもありません。
 * かわりに、wrangler.jsonc の ai バインディングが要ります。
 */
async function cfGenerate(request, env) {
  if (!env.AI) {
    return text("この中継では Workers AI が有効になっていません。"
      + "wrangler.jsonc の \"ai\" バインディングを入れて配備し直してください", 503);
  }
  const body = await readJson(request);
  const model = String(body?.model ?? "");
  if (!ALLOWED_CF_MODELS.has(model)) return text("そのモデルは使えません", 400);
  const messages = Array.isArray(body?.messages) ? body.messages.slice(0, 8) : null;
  if (!messages?.length) return text("messages が要ります", 400);
  const temperature = Number.isFinite(body?.temperature) ? body.temperature : 0.4;
  const maxTokens = Math.min(4096, Number(body?.max_tokens) || 2048);

  // モデルによって受け取る形が違います。messages で駄目なら prompt で。
  let out;
  let firstError = null;
  try {
    out = await env.AI.run(model, { messages, temperature, max_tokens: maxTokens });
  } catch (e) {
    firstError = e;
    try {
      out = await env.AI.run(model, {
        prompt: messages.map((m) => String(m?.content ?? "")).join("\n\n"),
        temperature, max_tokens: maxTokens,
      });
    } catch (e2) {
      // 「処理できませんでした」では、直しようがありません。上流の言い分を
      // そのまま渡します。
      return text(`Workers AI（${model}）: `
        + String(e2?.message ?? firstError?.message ?? e2).slice(0, 300), 502);
    }
  }

  const answer = cfText(out);
  if (!answer) {
    // 返事の入れ物はモデルによって違います。空だったときは、どの鍵が
    // 来ているかだけ返します（中身は返しません）。次の一手が決まります。
    return json({ text: "", shape: Object.keys(out ?? {}).slice(0, 12) });
  }
  return json({ text: answer });
}

/**
 * Workers AI の返事から本文を取り出します。
 *
 * 入れ物がモデルによって違います（response / result.response /
 * choices[].message.content / output[].content[].text）。1つだけを見ていて、
 * Gemma 4 が空で返ってきました。順に当たり、どれも無ければ木をたどります。
 */
export function cfText(out) {
  if (typeof out === "string") return out.trim();
  const direct = [
    out?.response,
    out?.result?.response,
    out?.output_text,
    out?.choices?.[0]?.message?.content,
    out?.choices?.[0]?.text,
  ];
  for (const c of direct) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  const parts = [];
  const walk = (node, depth = 0) => {
    if (!node || depth > 6) return;
    if (typeof node === "string") { parts.push(node); return; }
    if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
    if (typeof node === "object") {
      if (typeof node.text === "string") { parts.push(node.text); return; }
      for (const key of ["content", "output", "message", "delta"]) {
        if (node[key]) walk(node[key], depth + 1);
      }
    }
  };
  walk(out?.output ?? out?.result ?? out?.content ?? null);
  return parts.join("").trim();
}

async function gemini(request, env, method) {
  const missing = missingSecret(env, "GEMINI_API_KEY");
  if (missing) return missing;
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

  // 同じ検索は、取りに行きません。
  //
  // 旅程1つで区間の数だけ聞きますし、条件を少し変えて何度も作り直します。
  // 同じ日・同じ区間なら答えも同じなので、そのたびにYahoo!へ行くのは
  // 相手にも失礼で、断られる（429）もとになります。1時間置きます。
  const cacheKey = new Request(u.toString(), { method: "GET" });
  const cache = globalThis.caches?.default;
  const cached = await cache?.match(cacheKey);
  const res = cached ?? await fetch(u, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; TabisakiTransit/1.0)",
      "Accept-Language": "ja-JP,ja;q=0.9",
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) {
    // 断られたのがYahoo!なのか、こちらの回数制限なのかが分かるように
    // 書きます。同じ「429」でも、待つ先が違います。
    if (res.status === 429) {
      return text("Yahoo!路線情報から一時的に断られています（429）。"
        + "少し時間をおくと戻ります。それまでは、駅の位置からの目安で"
        + "組み立てます。", 429, { "Retry-After": "60" });
    }
    return text(`Yahoo Transit ${res.status}`, 502);
  }

  const html = await res.text();
  if (!cached && cache) {
    // 本文はもう読んでしまったので、控えは作り直して入れます。
    await cache.put(cacheKey, new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8",
                 "Cache-Control": "max-age=3600" },
    }));
  }
  const requestedMinutes = tokyoClockMinutes(requested);

  // 候補は全部読みます。1本目だけを見ていたときは、Yahoo!が「早い順」で
  // 並べた1本しか使えませんでした。
  const routes = [];
  for (const block of routeBlocks(html)) {
    const summary = parseSummary(block);
    const detail = parseRouteDetail(block);
    const departure = summary.departure ?? detail.departure;
    const arrival = summary.arrival ?? detail.arrival;
    if (!departure || !arrival) continue;
    const rideMinutes = departure !== arrival
      ? clockDiff(departure, arrival)
      : (summary.minutes ?? 0);
    // 0分の経路は捨てます。旅程では「移動時間0分」が「隣にある」と
    // 同じ意味になり、行けない予定が組めてしまいます。
    if (!(rideMinutes > 0)) continue;
    const waitMinutes = (clockMinutes(departure) - requestedMinutes + 1440) % 1440;
    routes.push({
      minutes: waitMinutes + rideMinutes,
      rideMinutes, waitMinutes, departure, arrival,
      summary: summary.text,
      transfers: summary.transfers,
      fareYen: summary.fareYen,
      distanceKm: summary.distanceKm,
      legs: detail.legs,
      intermediateStops: detail.intermediateStops,
    });
  }

  if (!routes.length) {
    return json({ routed: false, url: u.toString(),
      reason: "Yahoo!路線情報から経路を取り出せませんでした" });
  }

  // 採るのは「その時刻に出て、いちばん早く着く」もの。乗車時間ではなく
  // **待ち時間を含めた着時刻**で選びます。始発待ちの長い速達より、
  // すぐ乗れる各駅のほうが早く着くことがあります。
  const best = routes.reduce((a, b) => (a.minutes <= b.minutes ? a : b));

  return json({
    routed: true,
    minutes: best.minutes,
    rideMinutes: best.rideMinutes,
    waitMinutes: best.waitMinutes,
    summary: best.summary,
    meta: {
      url: u.toString(),
      departure: best.departure,
      arrival: best.arrival,
      requestedDeparture: requested.toISOString(),
      transfers: best.transfers,
      fareYen: best.fareYen,
      distanceKm: best.distanceKm,
      legs: best.legs,
      intermediateStops: best.intermediateStops,
      // 残りの候補。画面で「ほかの行き方」として出せます。
      alternatives: routes.filter((r) => r !== best).map((r) => ({
        departure: r.departure, arrival: r.arrival, minutes: r.minutes,
        rideMinutes: r.rideMinutes, transfers: r.transfers,
        fareYen: r.fareYen, distanceKm: r.distanceKm, summary: r.summary,
      })),
    },
  });
}

/** class に「その名前がそのまま入っている」li の中身。 */
function liWithClass(html, name) {
  // `class=[^"]*time` のような書き方は、`icnPriTime`（早・楽の印）にも
  // 当たります。実際そうなっていて、所要時間の行ではなく「早」の字を
  // 読んでいました。名前は区切って突き合わせます。
  const re = /<li[^>]*class=["']([^"']*)["'][^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[1].split(/\s+/).includes(name)) return cleanText(m[2]);
  }
  return "";
}

export function parseSummary(html) {
  const box = html.match(/class=["'][^"']*routeSummary[^"']*["'][\s\S]{0,20000}/i)?.[0] ?? "";
  const time = liWithClass(box, "time");
  const transferText = liWithClass(box, "transfer");
  const fareText = liWithClass(box, "fare");
  const distanceText = liWithClass(box, "distance");
  const transfers = Number(transferText.match(/(\d+)/)?.[1] ?? 0);
  const fareYen = Number((fareText.match(/([\d,]+)\s*円/)?.[1] ?? "0").replace(/,/g, "")) || null;
  const distanceKm = Number((distanceText.match(/([\d.]+)km/)?.[1] ?? "0")) || null;
  // 「10:00発→11:27着 1時間27分(乗車1時間27分)」から時刻と所要時間を取ります。
  // ここが**いちばん確かな出どころ**です。下の明細はHTMLの作りが変わると
  // 空になりますが、この行は要約として必ず出ます。
  const clock = [...time.matchAll(/(\d{1,2}:\d{2})/g)].map((m) => m[1]);
  const dur = time.match(/(?:(\d+)\s*時間)?\s*(\d+)\s*分/);
  const minutes = dur ? Number(dur[1] ?? 0) * 60 + Number(dur[2]) : null;
  return {
    text: [time, transferText, fareText, distanceText].filter(Boolean).join(" / "),
    transfers, fareYen, distanceKm,
    departure: clock[0] ?? null, arrival: clock[1] ?? null, minutes,
  };
}

/** 候補ごとのHTML。route01, route02, … を切り出します。 */
export function routeBlocks(html) {
  const marks = [];
  const re = /id=["']route(\d{2})["']/gi;
  let m;
  while ((m = re.exec(html))) marks.push(m.index);
  if (!marks.length) return [html];
  return marks.map((start, i) => html.slice(start, marks[i + 1] ?? html.length));
}

/** いちばん上の候補だけ。 */
export function firstYahooRoute(html) {
  return routeBlocks(html)[0];
}

/**
 * class に「その名前がそのまま入っている」div の位置。
 *
 * `class=[^"]*routeDetail` のような書き方だと、外側の
 * `class="elmRouteDetail"` にも当たります。実際そうなっていて、
 * 明細ではなく要約の部分だけを見ていたため、駅が1件も取れず
 * 所要時間が0分になっていました。名前は区切って突き合わせます。
 */
export function divsWithClass(html, name) {
  const re = /<div[^>]*class=["']([^"']*)["'][^>]*>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    if (m[1].split(/\s+/).includes(name)) out.push({ start: m.index, end: re.lastIndex });
  }
  return out;
}

export function parseRouteDetail(html) {
  const blocks = divsWithClass(html, "routeDetail");
  const detail = blocks.length
    ? html.slice(blocks[0].end, blocks[1]?.start ?? html.length)
    : html;

  // 駅の区切りは「次の駅ブロックが始まるまで」です。あいだには
  // 運賃や路線の欄が挟まります（駅 → fareSection → 駅）。
  const marks = divsWithClass(detail, "station");
  const stations = [];
  for (let i = 0; i < marks.length; i++) {
    const chunk = detail.slice(marks[i].end, marks[i + 1]?.start ?? detail.length);
    const name = cleanText(firstMatch(chunk, /<dt[^>]*>([\s\S]*?)<\/dt>/i));
    const head = chunk.slice(0, chunk.search(/<dl[^>]*>/i) + 1 || chunk.length);
    // 乗換駅は「10:39着 / 10:48発」のように、時刻のうしろに文字が付きます。
    // 時刻だけの行にしか当てていなかったので、乗換駅の時刻が
    // 取れていませんでした。中身から時刻を拾います。
    const times = [...head.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((m) => cleanText(m[1]).match(/(\d{1,2}:\d{2})/)?.[1])
      .filter(Boolean);
    if (name) stations.push({ name, times });
  }

  const transports = [];
  const transportRe = /<li[^>]*class=["'][^"']*transport[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let tm;
  while ((tm = transportRe.exec(detail))) {
    const text = cleanText(tm[1]);
    if (text) transports.push(text.replace(/^\[?(?:train|line)\]?\s*/i, ""));
  }

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

  const departure = stations[0]?.times[0] ?? null;
  const arrival = stations.at(-1)?.times.at(-1) ?? null;
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
  // 鍵が無いまま投げると、Googleから「API key not valid」が返ります。
  // 読んだ人は、自分の入力を疑います。**ここに鍵が無いだけ**なので、
  // 上流へ行く前に、そう言います。
  const missing = missingSecret(env, "MAPS_API_KEY");
  if (missing) return missing;
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
export function cors(res, origin, allow = [DEFAULT_ALLOW_ORIGIN]) {
  const h = new Headers(res.headers);
  // 許した出どころには、その出どころをそのまま返します。固定の1つを
  // 返していたので、公開先が2つあると片方が必ず「Load failed」でした。
  const ok = allow.includes("*") ? (origin || "*")
    : (allow.includes(origin) ? origin : allow[0]);
  h.set("Access-Control-Allow-Origin", ok);
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS"); h.set("Access-Control-Allow-Headers", "Content-Type, X-Goog-FieldMask");
  h.set("X-Content-Type-Options", "nosniff"); h.set("X-Frame-Options", "DENY"); h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains"); h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}
