// エリア別のページ（areas/）を、kb/ から作る道具。
//
// 旅さき本体は1ページのアプリです。検索から来る人は「箱根 日帰り
// モデルコース」「金沢 観光地」のように**場所の名前で**探しますが、
// アプリの1ページにはその言葉がありません。場所ごとに、読める
// ページを置きます。
//
//   areas/index.html              都道府県とエリアの一覧
//   areas/<県>/index.html         その県の定番・穴場・エリア
//   areas/<県>/<エリア>.html      そのエリアの1日のモデルコース
//
// モデルコースは、アプリと**同じエンジン**（js/pipeline.js）で組みます。
// 中継（AI・経路検索）へは出ないので、移動時間は距離からの目安です。
// ページにもそう書きます。
//
// リポジトリには入れません。公開のたびに .github/workflows/pages.yml が
// 作ります（収録が変わるたびに作り直し忘れる、ということが起きません）。
// 手元で見るときは:
//
//     node tools/build_area_pages.mjs dist
//     # dist/areas/index.html を開く
//
// どこにも送りません。読むのは kb/ だけです。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;

/** 公開URLの根。sitemap.xml の1件目から読みます（無ければこれ）。 */
const DEFAULT_BASE = "https://shitianliang1000-alt.github.io/tabisaki.github.io/";

/** 1ページに並べる数。多すぎると読まれず、少なすぎると探しに来た場所がありません。 */
const PREF_MAJOR = 12;
const PREF_HIDDEN = 12;
const REGION_SPOTS = 24;

export function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/** `spots-jp13-tokyo.json` → `tokyo`。 */
export function shardSlug(file) {
  const m = /^spots-jp\d{2}-([a-z]+)\.json$/.exec(String(file ?? ""));
  return m ? m[1] : null;
}

/** 次の土曜（その日が土曜なら翌週）。曜日で休館と混雑が変わるので、例は土曜で揃えます。 */
export function nextSaturday(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() + (((6 - d.getDay()) + 7) % 7 || 7));
  return d;
}

/** アプリへのリンク。`?q=` は「どんな旅にしたい？」の欄に入るだけです。 */
export function appLink(rel, text) {
  return `${rel}index.html?q=${encodeURIComponent(text)}`;
}

const GENRE_PROMPT = {
  onsen: "温泉でゆっくり",
  nature: "自然の中を歩く",
  history: "歴史ある街並みと寺社をめぐる",
  art: "美術館と建築を見てまわる",
  sea: "海をながめてのんびり",
  food: "名物を食べ歩く",
  view: "景色のいい場所を訪ねる",
  city: "街歩きを楽しむ",
};

/** そのエリアで書けそうな「どんな旅にしたい？」の例。 */
export function examplePrompts(region) {
  const out = [`${region.name}を1日でめぐる`];
  for (const g of region.genres ?? []) {
    if (GENRE_PROMPT[g]) out.push(`${region.name}で${GENRE_PROMPT[g]}`);
    if (out.length >= 4) break;
  }
  return out;
}

const TIER_LABEL = { major: "定番", known: "知る人ぞ知る", hidden: "穴場" };

function byFame(a, b) {
  return (b.fame_score ?? 0) - (a.fame_score ?? 0)
    || String(a.name).localeCompare(String(b.name), "ja");
}

/**
 * 県のページに並べる場所。定番は有名な順、穴場は説明のあるものから。
 * 説明の無い穴場を並べても、読む人には名前しか分かりません。
 */
export function pickPrefSpots(spots) {
  const list = (spots ?? []).filter((s) => s?.name);
  const major = list.filter((s) => s.fame_tier === "major" || s.fame_tier === "known")
    .sort(byFame).slice(0, PREF_MAJOR);
  const taken = new Set(major.map((s) => s.id));
  const hidden = list.filter((s) => s.fame_tier === "hidden" && s.description
                                    && !taken.has(s.id))
    .sort(byFame).slice(0, PREF_HIDDEN);
  return { major, hidden };
}

function fmtDate(d) {
  const w = "日月火水木金土"[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日（${w}）`;
}

function fmtTime(d) {
  const x = new Date(d);
  return `${x.getHours()}:${String(x.getMinutes()).padStart(2, "0")}`;
}

function page({ title, description, canonical, rel, body, jsonLd }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'none'; base-uri 'self'; form-action 'none'">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="旅さき">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(new URL(`${rel}og.png`, canonical).href)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#F4F1EB">
<link rel="icon" href="${rel}icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${rel}css/hig-tokens.css">
<link rel="stylesheet" href="${rel}css/hig.css">
<link rel="stylesheet" href="${rel}css/area.css">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>\n` : ""}</head>
<body>
<header class="area-bar">
  <a class="brand" href="${rel}index.html"><img src="${rel}icon.svg" alt="" width="22" height="22">旅さき</a>
  <a class="bar-link" href="${rel}areas/index.html">エリアから探す</a>
</header>
<main class="area">
${body}
</main>
<footer class="area-foot">
  <p>収録データ: 国土数値情報・OpenStreetMap・Wikipedia ほか（出典は<a href="${rel}credits.html">著作権・出典</a>のページにまとめています）。営業時間や料金は変わることがあります。お出かけ前に公式の情報をご確認ください。</p>
  <p><a href="${rel}index.html">旅さき</a> — 行きたいことから旅程をつくる</p>
</footer>
</body>
</html>
`;
}

function spotList(spots) {
  if (!spots.length) return "";
  return `<ul class="spots">
${spots.map((s) => `  <li><span class="sp-name">${esc(s.name)}</span>`
    + `<span class="sp-meta">${esc(s.category ?? "")}`
    + `${s.fame_tier ? `・${esc(TIER_LABEL[s.fame_tier] ?? "")}` : ""}</span>`
    + (s.description ? `<span class="sp-desc">${esc(s.description)}</span>` : "")
    + "</li>").join("\n")}
</ul>`;
}

function promptLinks(rel, prompts) {
  return `<ul class="prompts">
${prompts.map((p) => `  <li><a class="cta" href="${esc(appLink(rel, p))}">「${esc(p)}」で旅程をつくる</a></li>`).join("\n")}
</ul>`;
}

/** モデルコース（その日の行）。旅程が組めなかったときは null。 */
export function courseItems(itin) {
  const day = itin?.days?.[0];
  if (!day?.items?.length) return null;
  const out = [];
  for (const it of day.items) {
    const minutes = Math.round((new Date(it.end) - new Date(it.start)) / 60000);
    if (it.kind === "spot") {
      out.push({ kind: "spot", time: fmtTime(it.start), minutes, title: it.title,
                 text: it.place?.description ?? "", category: it.place?.category ?? "" });
    } else if (it.kind === "transit") {
      out.push({ kind: "move", time: fmtTime(it.start), minutes, title: "移動" });
    } else if (it.kind === "meal") {
      out.push({ kind: "meal", time: fmtTime(it.start), minutes, title: it.title || "食事" });
    } else if (it.kind === "free") {
      out.push({ kind: "free", time: fmtTime(it.start), minutes, title: "自由時間" });
    }
  }
  return out.some((x) => x.kind === "spot") ? out : null;
}

function courseHtml(items) {
  return `<ol class="course">
${items.map((x) => `  <li class="c-${x.kind}"><b class="c-time">${esc(x.time)}</b>`
    + `<span class="c-title">${esc(x.title)}${x.kind === "move" ? `（約${x.minutes}分・目安）` : `<small>${x.minutes}分</small>`}</span>`
    + (x.text ? `<span class="c-text">${esc(x.text)}</span>` : "")
    + "</li>").join("\n")}
</ol>`;
}

export function renderRegionPage({ region, prefName, prefSlug, spots, course, date, base }) {
  const rel = "../../";
  const canonical = `${base}areas/${prefSlug}/${region.id}.html`;
  const title = `${region.name}の1日モデルコースと観光地｜旅さき`;
  const description = `${region.name}（${prefName}）を${region.station ?? "駅"}から1日でまわるモデルコース。`
    + (region.tagline ? `${region.tagline}。` : "")
    + "行きたいことを書くと、営業時間と移動時間まで合わせた旅程をつくれます。";
  const list = [...spots].sort(byFame).slice(0, REGION_SPOTS);
  const items = course ? courseItems(course) : null;
  const body = `<nav class="crumbs"><a href="${rel}areas/index.html">エリア</a> › <a href="${rel}areas/${prefSlug}/index.html">${esc(prefName)}</a> › ${esc(region.name)}</nav>
<h1>${esc(region.name)}</h1>
${region.tagline ? `<p class="lead">${esc(region.tagline)}</p>` : ""}
${region.description ? `<p>${esc(region.description)}</p>` : ""}
${items ? `<section>
<h2>1日のモデルコース</h2>
<p class="fine">${esc(fmtDate(date))}に${esc(region.station ?? "")}を9:00に出て、18:00までに戻る例です。旅さきのエンジンで組んでいます。移動時間は距離からの目安で、実際の便ではありません。</p>
${courseHtml(items)}
<p><a class="cta primary" href="${esc(appLink(rel, `${region.name}を1日でめぐる`))}">この条件で、自分の日付の旅程をつくる</a></p>
</section>` : ""}
<section>
<h2>こんな旅もつくれます</h2>
${promptLinks(rel, examplePrompts(region))}
</section>
<section>
<h2>${esc(region.name)}の観光地</h2>
${spotList(list)}
</section>`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TouristDestination",
    name: region.name,
    description: region.description || region.tagline || undefined,
    geo: Number.isFinite(region.lat)
      ? { "@type": "GeoCoordinates", latitude: region.lat, longitude: region.lng } : undefined,
    containedInPlace: { "@type": "AdministrativeArea", name: prefName },
    includesAttraction: list.slice(0, 12).map((s) => ({
      "@type": "TouristAttraction", name: s.name,
      ...(Number.isFinite(s.lat) ? { geo: { "@type": "GeoCoordinates", latitude: s.lat, longitude: s.lng } } : {}),
    })),
    url: canonical,
  };
  return { path: `areas/${prefSlug}/${region.id}.html`, url: canonical,
           html: page({ title, description, canonical, rel, body, jsonLd }) };
}

export function renderPrefPage({ prefName, prefSlug, spots, regions, base }) {
  const rel = "../../";
  const canonical = `${base}areas/${prefSlug}/index.html`;
  const { major, hidden } = pickPrefSpots(spots);
  const title = `${prefName}の観光地・定番と穴場｜旅さき`;
  const description = `${prefName}の定番の観光地と、知る人ぞ知る穴場。収録${spots.length.toLocaleString("ja-JP")}か所から、`
    + "行きたいことに合わせて旅程をつくれます。";
  const body = `<nav class="crumbs"><a href="${rel}areas/index.html">エリア</a> › ${esc(prefName)}</nav>
<h1>${esc(prefName)}の観光地</h1>
<p class="lead">収録 ${spots.length.toLocaleString("ja-JP")} か所。定番だけでなく、知る人ぞ知る場所も混ぜて旅程を組めます。</p>
<p><a class="cta primary" href="${esc(appLink(rel, `${prefName}で、定番と穴場をまぜて1日まわる`))}">${esc(prefName)}で旅程をつくる</a></p>
${regions.length ? `<section>
<h2>エリアのモデルコース</h2>
<ul class="regions">
${regions.map((r) => `  <li><a href="${esc(r.id)}.html"><b>${esc(r.name)}</b>${r.tagline ? `<span>${esc(r.tagline)}</span>` : ""}</a></li>`).join("\n")}
</ul>
</section>` : ""}
${major.length ? `<section>
<h2>定番の観光地</h2>
${spotList(major)}
</section>` : ""}
${hidden.length ? `<section>
<h2>穴場</h2>
${spotList(hidden)}
</section>` : ""}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TouristDestination",
    name: prefName,
    includesAttraction: major.map((s) => ({ "@type": "TouristAttraction", name: s.name })),
    url: canonical,
  };
  return { path: `areas/${prefSlug}/index.html`, url: canonical,
           html: page({ title, description, canonical, rel, body, jsonLd }) };
}

export function renderIndexPage({ prefs, base }) {
  const rel = "../";
  const canonical = `${base}areas/index.html`;
  const title = "エリアから探す — 都道府県の観光地とモデルコース｜旅さき";
  const description = "47都道府県の定番の観光地と穴場、主なエリアの1日モデルコース。"
    + "行きたいことを書くと、旅さきが営業時間と移動時間まで合わせた旅程をつくります。";
  const body = `<h1>エリアから探す</h1>
<p class="lead">都道府県を選ぶと、定番と穴場、主なエリアのモデルコースが見られます。</p>
<ul class="prefs">
${prefs.map((p) => `  <li><a href="${esc(p.slug)}/index.html"><b>${esc(p.name)}</b>`
    + `<span>${p.count.toLocaleString("ja-JP")}か所${p.regions.length ? `・${p.regions.map((r) => esc(r.name)).join("・")}` : ""}</span></a></li>`).join("\n")}
</ul>`;
  return { path: "areas/index.html", url: canonical,
           html: page({ title, description, canonical, rel, body }) };
}

export function sitemapXml(base, urls, date) {
  const day = date.toISOString().slice(0, 10);
  const row = (loc, pri) => `  <url>\n    <loc>${esc(loc)}</loc>\n    <lastmod>${day}</lastmod>\n    <priority>${pri}</priority>\n  </url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- tools/build_area_pages.mjs が公開のたびに作ります。手で直さないでください。 -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[row(base, "1.0"), ...urls.map((u) => row(u, u.endsWith("areas/index.html") ? "0.8" : "0.6"))].join("\n")}
</urlset>
`;
}

/**
 * そのエリアのモデルコースとして出してよいか。
 *
 * 公開のページには、直す人がいません。おかしな旅程は出さずに、
 * 観光地の一覧だけのページにします。
 *   ・違うエリアへ行ってしまった（立ち寄りがよそのエリアのもの）
 *   ・必ず入れた3か所のうち、2か所以上が抜けた
 */
export function courseFits(itin, region, mustIds = []) {
  if (!itin || itin.regionId !== region.id) return false;
  const spots = (itin.days?.[0]?.items ?? []).filter((i) => i.kind === "spot");
  if (!spots.length) return false;
  if (spots.some((i) => i.place?.regionId && i.place.regionId !== region.id)) return false;
  const got = new Set(spots.map((i) => i.spotId ?? i.place?.id));
  const kept = mustIds.filter((id) => got.has(id)).length;
  return mustIds.length === 0 || kept >= Math.min(2, mustIds.length);
}

/** 名所として紹介できるエリア（説明を持つもの）。機械で作ったエリア名は「村」などで、見出しに使えません。 */
export function curatedRegions(regions) {
  return (regions ?? []).filter((r) => r?.tagline && r?.description && r?.station);
}

/**
 * 全ページを作ります。
 *
 * @param {{index:object, regions:object[], shards:Map<string,object[]>}} kbDoc
 * @param {{base:string, now:Date, planCourse?:(region)=>Promise<object|null>}} opts
 */
export async function buildAll(kbDoc, { base, now = new Date(), planCourse = null } = {}) {
  const date = nextSaturday(now);
  const regions = curatedRegions(kbDoc.regions);
  const pages = [];
  const prefs = [];
  for (const shard of kbDoc.index.shards ?? []) {
    const slug = shardSlug(shard.file);
    if (!slug) continue;
    const spots = kbDoc.shards.get(shard.file) ?? [];
    const prefName = shard.prefecture;
    const mine = regions.filter((r) => r.prefecture === prefName);
    prefs.push({ name: prefName, slug, count: spots.length, regions: mine });
    pages.push(renderPrefPage({ prefName, prefSlug: slug, spots, regions: mine, base }));
    for (const region of mine) {
      const own = spots.filter((s) => s.regionId === region.id);
      let course = null;
      if (planCourse) {
        try { course = await planCourse(region, date, own); } catch { course = null; }
      }
      pages.push(renderRegionPage({ region, prefName, prefSlug: slug, spots: own,
                                    course, date, base }));
    }
  }
  pages.unshift(renderIndexPage({ prefs, base }));
  return { pages, sitemap: sitemapXml(base, pages.map((p) => p.url), now) };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main(outDir) {
  const index = await readJson(join(ROOT, "kb/index.json"));
  const { regions } = await readJson(join(ROOT, "kb", index.regionsFile ?? "regions.json"));
  const shards = new Map();
  for (const s of index.shards ?? []) {
    shards.set(s.file, (await readJson(join(ROOT, "kb", s.file))).spots ?? []);
  }

  let base = DEFAULT_BASE;
  try {
    const xml = await readFile(join(ROOT, "sitemap.xml"), "utf8");
    base = /<loc>([^<]+)<\/loc>/.exec(xml)?.[1] ?? base;
  } catch { /* 既定のまま */ }
  if (!base.endsWith("/")) base += "/";

  // アプリのエンジンを、ブラウザの代わりにディスクから kb/ を読ませて動かします
  // （tools/plan_preview.mjs と同じ仕掛けです）。外へは出しません。
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!u.includes("/kb/") && !u.startsWith("file:")) throw new Error("network off");
    const path = u.startsWith("file:") ? new URL(u).pathname
      : join(ROOT, u.replace(/^.*\/kb\//, "kb/"));
    const body = await readFile(path, "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  };
  const { loadKnowledgeBase } = await import(join(ROOT, "js/kb.js"));
  const { planTrip } = await import(join(ROOT, "js/pipeline.js"));
  const { makeTrip } = await import(join(ROOT, "js/trip.js"));
  const kb = await loadKnowledgeBase();

  const planCourse = async (region, date, own) => {
    const at = (h) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), h);
    // そのエリアでいちばん知られた3か所は、必ず入れます。
    //
    // 入れないと、エンジンは「鎌倉を1日で」を鎌倉市ぜんたいの話として
    // 読み、大仏も八幡宮も無い旅程を組むことがあります（実際に組みました）。
    // アプリでは利用者が直せますが、モデルコースは直す人がいません。
    const mustIds = [...own].sort(byFame).slice(0, 3).map((s) => s.id);
    const itin = await planTrip({ kb, trip: makeTrip({
      must: { spotIds: mustIds },
      origin: { name: region.station, lat: region.stationLat, lng: region.stationLng },
      departAt: at(9), arriveBy: at(18),
      note: `${region.name}を1日でめぐる`, interests: [],
      dayStartHour: 9, dayEndHour: 18,
    }) });
    return courseFits(itin, region, mustIds) ? itin : null;
  };

  const { pages, sitemap } = await buildAll({ index, regions, shards },
    { base, now: new Date(), planCourse });
  for (const p of pages) {
    const file = join(outDir, p.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, p.html);
  }
  await writeFile(join(outDir, "sitemap.xml"), sitemap);
  const withCourse = pages.filter((p) => p.html.includes('class="course"')).length;
  console.log(`areas: ${pages.length}ページ（モデルコース ${withCourse}件）→ ${outDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  if (!out) {
    console.error("使いかた: node tools/build_area_pages.mjs <出力先>");
    process.exit(2);
  }
  await main(out);
}
