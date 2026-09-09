// 停留所（駅・バス停）の位置から、経路APIが届かない区間の
// 「なんとなくの目安」を組み立てるための下ごしらえ。
//
// なぜ要るか
//   Routes API は、バスしかない区間や登山道では ZERO_RESULTS を返す
//   （js/routes.js のコメント参照）。そのとき今までは出発地→目的地の
//   直線距離だけで見積もっていたが、たとえば富士山五合目のように
//   「バス停までは速い公共交通、そこから先は徒歩（登山道）」という
//   区間を、ぜんぶ同じ速さで計算すると大きく外れる。
//   停留所の実位置が分かれば、「最寄り停留所まで徒歩→停留所間は
//   目安の速さ→最寄り停留所から先は徒歩」と分けて見積もれる。
//
// 出典・作成年について（tools/build_stops.py も参照）
//   kb/stops-rail.json … 国土数値情報(鉄道) 2008年度版。全国の駅。
//   kb/stops-bus.json  … 同(バス停留所) 2012年3月時点。登山まわりの
//                         スポットの近くだけを抜き出したもの（全国では
//                         25万件を超え、静的サイトに乗せる大きさではない）。
//   どちらも「今の時刻表」ではなく「だいたいの位置」の目安でしかない。

import { haversineKm } from "./feasibility.js";

const CELL_DEG = 0.05; // 約5.5km四方。半径5〜8km圏内の探索に足りる粗さ。

function cellOf(lat, lng) {
  return `${Math.round(lat / CELL_DEG)},${Math.round(lng / CELL_DEG)}`;
}

function buildGrid(stops) {
  const grid = new Map();
  for (const s of stops) {
    const key = cellOf(s[0], s[1]);
    const list = grid.get(key);
    if (list) list.push(s); else grid.set(key, [s]);
  }
  return grid;
}

async function fetchStops(name) {
  try {
    const url = new URL(`../kb/${name}`, import.meta.url).toString();
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.stops) ? data.stops : [];
  } catch {
    // 読めなくても、経路の計算そのものは止めない（直線距離の目安に戻る）。
    return [];
  }
}

let loadPromise = null;

/**
 * 読み込みは1回だけ。位置で引く索引と、名前で引く索引の両方を作ります。
 *
 * 名前の索引は、出発地・到着地の入力補完に使います。datalist に
 * 7万件を並べるとブラウザが固まるので、打たれた文字で絞ってから
 * 20件だけ差し込みます。
 */
function load() {
  loadPromise ??= Promise.all([
    fetchStops("stops-rail.json"),
    fetchStops("stops-bus.json"),
  ]).then(([rail, bus]) => {
    // 駅を先に置きます。同じ名前ならバス停より駅を採ります
    // （「新宿駅」と打った人が新宿駅前のバス停に案内されないように）。
    const all = [
      ...rail.map((s) => ({ lat: s[0], lng: s[1], name: s[2], kind: "rail" })),
      ...bus.map((s) => ({ lat: s[0], lng: s[1], name: s[2], kind: "bus" })),
    ];
    const byName = new Map();
    for (const s of all) {
      const key = normalizeName(s.name);
      if (!byName.has(key)) byName.set(key, s);
    }
    return { grid: buildGrid(all.map((s) => [s.lat, s.lng, s.name])), all, byName };
  });
  return loadPromise;
}

function loadGrid() {
  return load().then((x) => x.grid);
}

/** 「新宿駅」「 新宿 」を同じ鍵にします。 */
function normalizeName(name) {
  return String(name ?? "").trim().replace(/[\s　]+/g, "").replace(/駅$/, "");
}

/**
 * 先に読み込んでおきます。
 *
 * 停留所のデータは2.7MBあり、最初の1回は数秒かかります。使う直前に
 * 取りにいくと、その数秒ぶん候補が出ません。触れた時点で始めます。
 */
export function preloadStops() {
  load().catch(() => { /* 読めなくても、直線距離の目安に戻るだけです */ });
}

/**
 * 名前の一致で停留所を1件引きます。駅を優先します。
 * @returns {{lat,lng,name,kind}|null}
 */
export async function findStop(name) {
  const q = normalizeName(name);
  if (!q) return null;
  const { byName } = await load();
  return byName.get(q) ?? null;
}

/**
 * 入力補完の候補。打たれた文字で始まるものを先に返します。
 * @param {string} query
 * @param {number} limit
 */
export async function searchStops(query, limit = 20) {
  const q = normalizeName(query);
  if (q.length < 1) return [];
  const { all } = await load();
  const starts = [];
  const contains = [];
  for (const s of all) {
    const n = normalizeName(s.name);
    if (n === q || n.startsWith(q)) starts.push(s);
    else if (n.includes(q)) contains.push(s);
    if (starts.length >= limit) break;
  }
  // 同じ名前の停留所は全国にいくつもあります（「本町」など）。
  // 候補としては1つで足ります。
  const seen = new Set();
  const out = [];
  for (const s of [...starts, ...contains]) {
    const key = normalizeName(s.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 最寄りの停留所（駅・バス停）を返します。見つからなければ null。
 * @param {{lat:number,lng:number}} point
 * @param {number} maxKm この距離より遠ければ「無い」扱いにします
 */
export async function nearestStop(point, maxKm = 3) {
  const grid = await loadGrid();
  const cx = Math.round(point.lat / CELL_DEG);
  const cy = Math.round(point.lng / CELL_DEG);
  let best = null;
  let bestKm = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const list = grid.get(`${cx + dx},${cy + dy}`);
      if (!list) continue;
      for (const s of list) {
        const km = haversineKm(point, { lat: s[0], lng: s[1] });
        if (km < bestKm) {
          bestKm = km;
          best = { lat: s[0], lng: s[1], name: s[2], km };
        }
      }
    }
  }
  return best && bestKm <= maxKm ? best : null;
}

/** テスト・診断用に、読み込み状態をリセットします。 */
export function resetStopsCache() {
  loadPromise = null;
}
