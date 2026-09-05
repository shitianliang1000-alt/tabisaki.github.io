// 知識ベースの読み込みと検索。
//
// 公開された静的 JSON を取ってきて、ベクトル検索（または語句検索）を行います。
// シャード名にビルドIDが入っているため、ブラウザの HTTP キャッシュに任せて
// 問題ありません。独自のキャッシュ層は置きません。

import { KB_INDEX_URL } from "./config.js";
import { genresForCategory } from "./feasibility.js";
import { SAMPLE_KB } from "./sample-data.js";

const FAME_SCORE = { major: 82, known: 55, hidden: 26 };

/**
 * 公開知識ベースで省いた項目を補います。
 *
 * 1万件を超えると、エリア名・都道府県名・ジャンルといった「エリアから
 * 決まるもの」を1件ずつ持たせるだけでMB単位になります。ファイルには
 * 入れず、読み込んだここで埋めます。
 */
function hydrate(spot, region) {
  spot.region ??= region?.name ?? "";
  spot.prefecture ??= region?.prefecture ?? "";
  spot.prefectureId ??= spot.regionId;
  spot.country ??= region?.country ?? "日本";
  spot.genres ??= genresForCategory(spot.category);
  spot.wikipedia ??= spot.name;
  spot.fame_score ??= FAME_SCORE[spot.fame_tier] ?? 50;
  if (spot.src) {
    // 外部データは営業時間も料金も持っていません。確認済みとは区別します。
    spot.source ??= "external";
    spot.verified ??= false;
  }
  return spot;
}

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

function index(regions, spots) {
  const regionsById = new Map(regions.map((r) => [r.id, r]));
  const spotsByRegion = new Map();
  const spotsById = new Map();
  for (const s of spots) {
    spotsById.set(s.id, s);
    const list = spotsByRegion.get(s.regionId);
    if (list) list.push(s); else spotsByRegion.set(s.regionId, [s]);
  }
  return { regionsById, spotsByRegion, spotsById };
}

/**
 * 知識ベースを読み込みます。
 * KB_INDEX_URL が未設定なら、同梱のサンプルで動作します（動作確認用）。
 */
export async function loadKnowledgeBase(onProgress, signal) {
  if (!KB_INDEX_URL) {
    // 配列を複製してから返します。調べた結果を足す（mergeIntoKb）ときに
    // 同梱データそのものを書き換えてしまうと、読み込み直しても
    // 前回の結果が混ざったままになるためです。
    const regions = [...SAMPLE_KB.regions];
    const spots = [...SAMPLE_KB.spots];
    onProgress?.(1, 1, "サンプルデータ");
    return {
      source: "sample",
      manifest: { counts: { regions: regions.length, spots: spots.length } },
      regions, spots, ...index(regions, spots),
      hasVectors: spots.some((s) => s.v),
    };
  }

  // 相対パス（kb/index.json）でも書けるように解決します。
  //
  // 基準はページではなく、**このモジュールの位置**です。
  // ページを基準にすると、admin/index.html のような1階層下の画面から
  // 読んだときに /admin/kb/index.json を取りにいって 404 になり、
  // 黙って同梱データに落ちます（件数だけ 232 になって気づきにくい）。
  // kb/ は js/ と同じ高さにあるので、js/ の1つ上を基準にします。
  const appRoot = new URL("../", import.meta.url);
  const base = new URL(KB_INDEX_URL, appRoot).toString();

  let manifest;
  try {
    manifest = await getJson(base, signal);
  } catch (e) {
    // 公開知識ベースを読めないときに、真っ白で終わらせない。
    // 同梱データでも旅程は組めるので、そちらに落ちて理由を伝えます。
    const { regions, spots } = SAMPLE_KB;
    onProgress?.(1, 1, "同梱データ");
    return {
      source: "sample",
      loadError: `公開知識ベースを読み込めませんでした（${e.message}）。`
        + "同梱データで動作しています。",
      manifest: { counts: { regions: regions.length, spots: spots.length } },
      regions: [...regions], spots: [...spots],
      ...index([...regions], [...spots]),
      hasVectors: spots.some((s) => s.v),
    };
  }
  if (!manifest?.shards?.length) {
    throw new Error("index.json に shards がありません");
  }
  const total = manifest.shards.length + 1;
  onProgress?.(0, total, "地域データ");

  const regionsDoc = await getJson(
    new URL(manifest.regionsFile, base).toString(), signal);
  const regions = regionsDoc.regions ?? [];

  // シャードは並べて取ります。
  //
  // 1つずつ待っていた頃は、待ち時間が「往復 × シャード数」でした。
  // 手元では気になりませんが、旅行者が使うのは移動中の回線です。
  // 往復200msの回線なら、7枚で1.4秒が待つだけの時間になります。
  let done = 0;
  const docs = await Promise.all(manifest.shards.map(async (shard) => {
    const doc = await getJson(new URL(shard.file, base).toString(), signal);
    onProgress?.(++done, total, `スポット ${done}/${manifest.shards.length}`);
    return doc;
  }));

  const spots = [];
  for (const doc of docs) {
    // 出どころがシャード側にまとめて書かれていることがあります
    // （同じ文字列を全行に書くと、それだけで100KBを超えるため）。
    const from = doc.dataSource;
    for (const spot of doc.spots ?? []) {
      if (from && !spot.dataSource) spot.dataSource = from;
      spots.push(spot);
    }
  }
  onProgress?.(total, total, "完了");

  const idx = index(regions, spots);
  for (const spot of spots) hydrate(spot, idx.regionsById.get(spot.regionId));
  return {
    source: "remote", manifest, regions, spots, ...idx,
    // 出典の表示が求められるデータを含みます（国土数値情報など）。
    // 画面から消さないでください。
    attribution: manifest.sources ?? [],
    hasVectors: spots.some((s) => s.v),
  };
}

/**
 * 調べて得たエリア・スポットを、いま読み込んでいる知識ベースに足します。
 *
 * ファイルには書き戻しません。収録データ（確認済み）と、その場で調べた
 * データ（未確認）は出どころが違うので、混ぜて保存はしない方針です。
 * 同じ地名を続けて調べる負担は discover.js のキャッシュが受け持ちます。
 */
export function mergeIntoKb(kb, { regions = [], spots = [] } = {}) {
  let added = 0;
  for (const r of regions) {
    if (kb.regionsById.has(r.id)) continue;
    kb.regions.push(r);
    kb.regionsById.set(r.id, r);
  }
  for (const s of spots) {
    if (kb.spotsById.has(s.id)) continue;
    kb.spots.push(s);
    kb.spotsById.set(s.id, s);
    const list = kb.spotsByRegion.get(s.regionId);
    if (list) list.push(s); else kb.spotsByRegion.set(s.regionId, [s]);
    added++;
  }
  kb.__searchHaystack = undefined;   // areas.js が持つ照合用の文字列を作り直させる
  return added;
}

// --- ベクトル検索 -----------------------------------------------------------

/** base64（int8 を +128 したもの）→ Int8Array */
export function decodeVector(b64) {
  const bin = atob(b64);
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) - 128;
  return out;
}

/**
 * 量子化ベクトルとのコサイン類似度。
 * スケールはコサインで打ち消し合うため適用不要です。
 */
export function cosineToQuantized(query, q) {
  const n = Math.min(query.length, q.length);
  let dot = 0, nq = 0, ns = 0;
  for (let i = 0; i < n; i++) {
    dot += query[i] * q[i];
    nq += query[i] * query[i];
    ns += q[i] * q[i];
  }
  if (nq === 0 || ns === 0) return 0;
  return dot / (Math.sqrt(nq) * Math.sqrt(ns));
}

/**
 * 意味検索。hiddenBias が高いほど、知名度の低い場所を押し上げます。
 */
export function searchSpots(kb, queryVector, { limit = 260, hiddenBias = 0 } = {}) {
  const out = [];
  for (const spot of kb.spots) {
    if (!spot.v) continue;
    const sim = cosineToQuantized(queryVector, decodeVector(spot.v));
    const obscurity = 1 - Math.min(100, Math.max(0, spot.fame_score ?? 50)) / 100;
    out.push({ spot, score: sim + hiddenBias * 0.12 * obscurity });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/**
 * ベクトルが無い知識ベース、または埋め込み失敗時の語句検索。
 *
 * どこに当たったかで重みを変えます。以前は当たった語の数だけを見ていたので、
 * 収録が1万件を超えたとたん、「温泉」で名前に温泉を含む地元の小さな湯が
 * 大量に上位を占め、草津や箱根が消えました。名前に当たったのか、
 * 説明文に当たったのかは、同じ1件ではありません。
 */
const FIELD_WEIGHT = {
  name: 1.0, category: 0.6, genre: 0.5, region: 0.15, description: 0.3,
};

export function searchSpotsByKeyword(kb, keywords, { limit = 260, hiddenBias = 0 } = {}) {
  const terms = (keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
  if (!terms.length) {
    return kb.spots.slice(0, limit).map((spot) => ({ spot, score: 0.1 }));
  }
  const out = [];
  for (const spot of kb.spots) {
    let score = 0;
    for (const t of terms) {
      if (spot.name.includes(t)) score += FIELD_WEIGHT.name;
      else if ((spot.category ?? "").includes(t)) score += FIELD_WEIGHT.category;
      else if ((spot.genres ?? []).includes(t)) score += FIELD_WEIGHT.genre;
      else if ((spot.description ?? "").includes(t)) score += FIELD_WEIGHT.description;
      else if ((spot.region ?? "").includes(t)
               || (spot.prefecture ?? "").includes(t)) score += FIELD_WEIGHT.region;
    }
    if (!score) continue;
    score /= terms.length;

    // 知名度で伸び縮みさせる。穴場を消さない程度に留めます。
    const fame = Math.min(100, Math.max(0, spot.fame_score ?? 50));
    score *= 0.6 + 0.8 * (fame / 100);

    // 営業時間まで確認できているものを、わずかに優先します。
    if (spot.verified !== false) score *= 1.12;

    const obscurity = 1 - fame / 100;
    out.push({ spot, score: score + hiddenBias * 0.12 * obscurity });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/**
 * 地域ごとにまとめて順位付け。
 * 上位数件の平均で評価するので、弱い候補を大量に持つ大都市が
 * 数の力で勝つことはありません。
 */
/**
 * 往復して滞在する時間が残るか。
 *
 * これが無いと、東京から片道8時間の旅先が日帰り候補に混ざります。
 * 検索の類似度だけでは「行けるかどうか」は分からないので、
 * 順位付けの前に物理的にふるいます。
 */
export function reachableRegions(regions, { origin, endPlace, totalMinutes,
                                            nights = 0, travelFn,
                                            safetyBufferMin = 15 }) {
  // 終点は出発地とは限りません。片道の旅（東京→名古屋で終了）で
  // 往復を前提に判定すると、行けるはずの旅先が全部落ちます。
  const end = endPlace ?? origin;
  const minStay = nights === 0 ? 90 : 240;
  const kept = [];
  const rejected = [];
  for (const region of regions) {
    const station = { lat: region.stationLat, lng: region.stationLng };
    const oneWay = travelFn(origin, station);
    const toEnd = travelFn(station, end);
    const need = oneWay + toEnd + minStay + safetyBufferMin;
    if (need <= totalMinutes) kept.push({ region, oneWay, toEnd });
    else rejected.push({ region, oneWay, toEnd, need });
  }
  return { kept, rejected };
}

/**
 * 移動時間が旅全体に占める割合から、旅先の効率を評価します。
 *
 * 「往復できる」だけでは良い提案になりません。10時間のうち8時間が移動、
 * 滞在1時間という旅程は、実行可能ではあっても勧めるべきものではない。
 * 移動が全体の 55% を超えたあたりから急に価値が下がる、という形にしています。
 */
export function travelEfficiency(travelMin, totalMinutes) {
  if (!totalMinutes) return 0;
  const share = travelMin / totalMinutes;
  return Math.max(0, 1 - share / 0.55);
}

/**
 * その旅先で、無理なく回れる件数の見積もり。
 *
 * 1か所あたり「滞在70分＋次への移動20分」で見ます。細かく当てる必要は
 * ありません。近い旅先と遠い旅先で、回れる数が何倍違うかが分かれば
 * 順位付けには足ります。
 */
export function fittableSpots(oneWayMin, totalMinutes) {
  const left = totalMinutes - oneWayMin * 2;
  if (left <= 0) return 0;
  return Math.max(0, Math.floor(left / 90));
}

export function rankRegions(kb, matches, topPerRegion = 8, opts = {}) {
  const { oneWayByRegion, totalMinutes, wantedGenres = [], days = 1 } = opts;
  const wanted = new Set(wantedGenres);
  const spotsWanted = 5 * Math.max(1, days);   // 1日あたり5か所を目安に
  const byRegion = new Map();
  for (const m of matches) {
    const list = byRegion.get(m.spot.regionId);
    if (list) list.push(m); else byRegion.set(m.spot.regionId, [m]);
  }
  const out = [];
  for (const [regionId, list] of byRegion) {
    const region = kb.regionsById.get(regionId);
    if (!region) continue;
    list.sort((a, b) => b.score - a.score);
    const top = list.slice(0, topPerRegion);

    // 上位の加重和（重みは 1, 0.7, 0.49, … と減衰）。
    //
    // 平均で評価していたときは、強い一致が1件だけの町が、良い一致を3件
    // 持つ町に勝っていました（1件だけだと平均が薄まらないため）。
    // 減衰つきの和なら、件数が増えるほど有利になりつつ、弱い候補を大量に
    // 持つ大都市が数の力だけで勝つこともありません。
    let score = 0;
    let weight = 1;
    for (const m of top) {
      score += m.score * weight;
      weight *= 0.7;
    }

    // 知名度を効かせる。
    //
    // 収録が1万件を超えると、その大半は地元の祭りや小さな史跡です。
    // 一致の点数だけで並べると、「四国」で四国中央市の秋祭りが上位に来ます。
    // 「行ってみたい場所か」を測る手がかりとして、上位スポットの知名度を
    // 見ます（穴場を消さないよう、重みは控えめにします）。
    const fame = top.length
      ? top.reduce((a, m) => a + (m.spot.fame_score ?? 50), 0) / top.length
      : 50;
    score += 1.6 * (fame / 100);

    // 地域そのものの性格を効かせる。スポット単位の一致だけで順位を付けると、
    // 温泉施設が1つある山が、温泉街そのものと同じ扱いになります。
    // 「温泉でゆっくり」の答えは、日帰り湯のある高尾山ではなく箱根や熱海です。
    if (wanted.size) {
      const overlap = (region.genres ?? []).filter((g) => wanted.has(g)).length;
      score += 0.22 * overlap;
    }

    // 日数に対して見どころが足りない旅先は、泊まっても手持ち無沙汰になります。
    // 日帰りなら十分な小さな町でも、2泊3日の行き先としては物足りない。
    const available = kb.spotsByRegion.get(regionId)?.length ?? list.length;
    if (available < spotsWanted) {
      score -= 0.30 * (spotsWanted - available) / spotsWanted;
    }

    if (oneWayByRegion && totalMinutes) {
      const oneWay = oneWayByRegion.get(regionId);
      if (oneWay !== undefined) {
        // 移動の重みは、日帰りと泊まりで変えます。
        //
        // 泊まりなら、初日に3時間かけて行っても翌日以降で取り返せます。
        // 日帰りは取り返せません。往復5時間の旅先を選ぶと、その日は
        // 2〜3か所しか回れず、「行った気がしない」旅程になります。
        // 同じ重みで扱っていたときに、実際にそうなっていました。
        const weight = days <= 1 ? 0.95 : 0.35;
        score += weight * travelEfficiency(oneWay, totalMinutes);

        // 「その日、実際に何か所まわれるか」を直接点にします。
        // 移動を引いた残り時間を、1か所あたり(滞在+移動)で割った数です。
        // 日帰りではここが体験の量そのものなので、重めに見ます。
        const fitWeight = days <= 1 ? 0.55 : 0.25;
        score += fitWeight * Math.min(1, fittableSpots(oneWay, totalMinutes) / spotsWanted);
      }
    }
    out.push({ region, spots: top, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
