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

let gridPromise = null;

function loadGrid() {
  gridPromise ??= Promise.all([
    fetchStops("stops-rail.json"),
    fetchStops("stops-bus.json"),
  ]).then(([rail, bus]) => buildGrid([...rail, ...bus]));
  return gridPromise;
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
  gridPromise = null;
}
