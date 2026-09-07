from pathlib import Path

# routes.js: keep every existing export and replace only the TRANSIT branch.
p = Path("js/routes.js")
s = p.read_text()
marker = 'import { summarizeTransitLeg, transitFieldMask } from "./transit.js";'
if 'from "./yahoo-transit.js"' not in s:
    assert marker in s
    s = s.replace(marker, marker + '\nimport { searchYahooTransit } from "./yahoo-transit.js";', 1)

old = '''  if (mode === "TRANSIT") {
    const key = cacheKey(points, "TRANSIT-stations", opts.departAt);
    const hit = routeCache.get(key);
    if (hit) return hit;
    const result = await computeViaStations(points, opts);
    routeCache.set(key, result);
    return result;
  }'''

new = '''  if (mode === "TRANSIT") {
    const key = cacheKey(points, "TRANSIT-yahoo", opts.departAt);
    const hit = routeCache.get(key);
    if (hit) return hit;

    if (points.length === 2) {
      try {
        const [fromStop, toStop] = await Promise.all([
          nearestStop(points[0], 5),
          nearestStop(points[1], 5),
        ]);
        const yahoo = await searchYahooTransit(
          fromStop ?? points[0], toStop ?? points[1], opts,
        );
        if (yahoo?.routed && yahoo.minutes > 0) {
          const result = {
            legs: [{
              minutes: yahoo.minutes,
              meters: Math.round(haversineKm(points[0], points[1]) * 1000),
              line: yahoo.summary ?? "Yahoo!路線情報",
              routed: true,
              yahoo: yahoo.meta ?? null,
            }],
            routed: true,
            mode: "TRANSIT",
            modeNote: "Yahoo!路線情報で検索",
          };
          routeCache.set(key, result);
          return result;
        }
      } catch (e) {
        usage.lastError = `Yahoo Transit: ${String(e?.message ?? e).slice(0, 200)}`;
      }
    }

    // Yahoo!で取得できない場合だけ、従来の駅・バス停ベース推定へ戻します。
    const result = await computeViaStations(points, opts);
    routeCache.set(key, result);
    return result;
  }'''

if old in s:
    s = s.replace(old, new, 1)
elif 'TRANSIT-yahoo' not in s:
    raise SystemExit("TRANSIT block not found")
p.write_text(s)

# Cloudflare Worker: add a server-side Yahoo fetch endpoint.
p = Path("server/worker.js")
s = p.read_text()
marker = 'const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";'
if 'const YAHOO_TRANSIT_URL' not in s:
    assert marker in s
    s = s.replace(marker, marker + '\nconst YAHOO_TRANSIT_URL = "https://transit.yahoo.co.jp/search/result";', 1)

dispatch = '''      if (path.endsWith("/routes")) {
        return cors(await routes(request, env), origin);
      }'''
if 'path.endsWith("/yahoo/transit")' not in s:
    assert dispatch in s
    s = s.replace(dispatch, dispatch + '''
      if (path.endsWith("/yahoo/transit")) {
        return cors(await yahooTransit(request), origin);
      }''', 1)

if 'async function yahooTransit(request)' not in s:
    fn = '''async function yahooTransit(request) {
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

  // Yahoo!路線情報の指定日時形式: dispDate=YYYYMMDDHHMM
  if (body?.departAt) {
    const d = new Date(body.departAt);
    if (!Number.isNaN(d.getTime())) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tokyo",
        year: "numeric", month: "2-digit", day: "2-digit",
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
  const route = html.match(/id=["']route01["'][\\s\\S]*?<\\/div>\\s*<\\/div>/i)?.[0] ?? html;
  const plain = route.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\\s+/g, " ").trim();
  const time = plain.match(/(\\d{1,2}:\\d{2})\\s*(?:発|出発)?[^0-9]{0,80}?(\\d{1,2}:\\d{2})\\s*(?:着|到着)?/);
  if (!time) {
    return json({ routed: false, url: u.toString(), reason: "Yahoo!路線情報の経路結果を取得できませんでした" });
  }

  const [h1, m1] = time[1].split(":").map(Number);
  const [h2, m2] = time[2].split(":").map(Number);
  let minutes = (h2 * 60 + m2) - (h1 * 60 + m1);
  if (minutes < 0) minutes += 1440;
  if (minutes <= 0 || minutes > 1440) return json({ routed: false, url: u.toString() });

  return json({
    routed: true,
    minutes,
    summary: plain.slice(0, 500),
    meta: { url: u.toString(), departure: time[1], arrival: time[2] },
  });
}

'''
    assert 'async function routes(request, env) {' in s
    s = s.replace('async function routes(request, env) {', fn + 'async function routes(request, env) {', 1)
p.write_text(s)
