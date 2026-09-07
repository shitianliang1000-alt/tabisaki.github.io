import fs from "node:fs";

const routesPath = "js/routes.js";
const workerPath = "server/worker.js";

let routes = fs.readFileSync(routesPath, "utf8");
let worker = fs.readFileSync(workerPath, "utf8");

const oldImport = 'import { nearestStop } from "./stops.js";';
const newImport = `${oldImport}\nimport { yahooTransit } from "./yahoo-transit.js";`;
if (!routes.includes(newImport)) {
  if (!routes.includes(oldImport)) throw new Error("routes.js import anchor not found");
  routes = routes.replace(oldImport, newImport);
}

const marker = "async function computeViaStations(points, opts) {";
const helper = `async function computeViaYahoo(points, opts) {
  const longest = longestLegKm(points);
  if (longest > 700) return null;
  const legs = [];
  let any = false;
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i];
    const to = points[i + 1];
    const r = await yahooTransit(from, to, { departAt: opts?.departAt, signal: opts?.signal });
    if (!r?.ok || !Number.isFinite(r.minutes)) return null;
    any = true;
    legs.push({
      minutes: Math.max(1, Math.round(r.minutes)),
      meters: Math.round(haversineKm(from, to) * 1000),
      line: r.summary ?? null,
      routed: true,
      transit: r.transit ?? { line: r.summary ?? null, segments: [] },
      stations: r.stations ?? null,
      yahoo: { url: r.url ?? null, departure: r.departure ?? null, arrival: r.arrival ?? null },
    });
  }
  return any ? { legs, routed: true, mode: "TRANSIT", modeNote: "Yahoo!路線情報で公共交通を検索" } : null;
}

`;
if (!routes.includes("async function computeViaYahoo(points, opts)")) {
  if (!routes.includes(marker)) throw new Error("computeViaStations anchor not found");
  routes = routes.replace(marker, helper + marker);
}

const oldBranch = `    const result = await computeViaStations(points, opts);\n    routeCache.set(key, result);\n    return result;`;
const newBranch = `    const yahoo = await computeViaYahoo(points, opts).catch(() => null);\n    const result = yahoo ?? await computeViaStations(points, opts);\n    routeCache.set(key, result);\n    return result;`;
if (!routes.includes(newBranch)) {
  if (!routes.includes(oldBranch)) throw new Error("TRANSIT branch anchor not found");
  routes = routes.replace(oldBranch, newBranch);
}

const route = `
/** Yahoo!路線情報をCloudflare Worker経由で呼び出す。 */
export async function yahooTransit(from, to, opts = {}) {
  const cfg = effectiveConfig();
  const base = String(cfg.proxyUrl ?? "").trim().replace(/\\/+$/, "");
  if (!base) return { ok: false, reason: "PROXY_URL未設定" };
  const body = {
    from,
    to,
    departAt: opts.departAt instanceof Date ? opts.departAt.toISOString() : opts.departAt ?? null,
  };
  const res = await fetch(`${base}/yahoo/transit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) return { ok: false, reason: `Yahoo transit ${res.status}` };
  return res.json();
}
`;
fs.writeFileSync("js/yahoo-transit.js", route.trimStart());

const workerMarker = '      if (path.endsWith("/routes")) {\n        return cors(await routes(request, env), origin);\n      }';
const workerRoute = `      if (path.endsWith("/routes")) {\n        return cors(await routes(request, env), origin);\n      }\n      if (path.endsWith("/yahoo/transit")) {\n        return cors(await yahooTransit(request), origin);\n      }`;
if (!worker.includes('path.endsWith("/yahoo/transit")')) {
  if (!worker.includes(workerMarker)) throw new Error("worker route anchor not found");
  worker = worker.replace(workerMarker, workerRoute);
}

const workerInsert = `\nasync function yahooTransit(request) {\n  const body = await readJson(request);\n  if (!body?.from || !body?.to) return text("Yahoo!路線情報の出発地と到着地が必要です", 400);\n  const from = encodeURIComponent(String(body.from));\n  const to = encodeURIComponent(String(body.to));\n  const url = new URL("https://transit.yahoo.co.jp/search/result");\n  url.searchParams.set("from", String(body.from));\n  url.searchParams.set("to", String(body.to));\n  url.searchParams.set("shin", "1");\n  url.searchParams.set("ex", "1");\n  url.searchParams.set("al", "1");\n  url.searchParams.set("s", "0");\n  const res = await fetch(url.toString(), {\n    headers: { "User-Agent": "Mozilla/5.0 (compatible; Tabisaki/1.0)" },\n    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),\n  });\n  if (!res.ok) return text(`Yahoo!路線情報 ${res.status}`, 502);\n  const html = await res.text();\n  const route = parseYahooTransitHtml(html);\n  if (!route) return text("Yahoo!路線情報から経路を取得できませんでした", 502);\n  return json({ ...route, ok: true, url: url.toString(), from: body.from, to: body.to });\n}\n\nfunction parseYahooTransitHtml(html) {\n  const root = html.match(/id=["']route01["'][\\s\\S]*?<\\/div>\\s*<\\/div>/i)?.[0] ?? html;\n  const time = root.match(/class=["'][^"']*time[^"']*["'][^>]*>\\s*([^<]+)/i)?.[1]?.trim();\n  const small = root.match(/class=["'][^"']*small[^"']*["'][^>]*>\\s*([^<]+)/i)?.[1]?.trim();\n  const times = [...root.matchAll(/(?:^|>)(\\d{1,2}:\\d{2})(?:<|$)/g)].map(m => m[1]);\n  const departure = times[0] ?? null;\n  const arrival = times[times.length - 1] ?? null;\n  let minutes = null;\n  const m = (time ?? small ?? "").match(/(\\d+)分/);\n  if (m) minutes = Number(m[1]);\n  if (!minutes && departure && arrival) {\n    const [dh, dm] = departure.split(":").map(Number);\n    const [ah, am] = arrival.split(":").map(Number);\n    let diff = ah * 60 + am - (dh * 60 + dm);\n    if (diff < 0) diff += 1440;\n    minutes = diff;\n  }\n  if (!minutes) return null;\n  const textContent = root.replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ").trim();\n  return { minutes, departure, arrival, summary: textContent.slice(0, 500), transit: { line: textContent.slice(0, 200), segments: [] } };\n}\n`;
if (!worker.includes("function yahooTransit(request)")) {
  const insertBefore = "async function gemini(request, env, method) {";
  if (!worker.includes(insertBefore)) throw new Error("worker function anchor not found");
  worker = worker.replace(insertBefore, workerInsert + "\n" + insertBefore);
}

fs.writeFileSync(routesPath, routes);
fs.writeFileSync(workerPath, worker);
console.log("Yahoo transit integration patched");
