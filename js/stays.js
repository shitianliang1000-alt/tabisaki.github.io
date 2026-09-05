// 「どこに何日いるか」を決める。
//
// 1エリアに固定していたころ、10日間の旅程が4スポットになりました。
// 収録6スポットのエリアに10日いれば当然そうなります。人はそういう旅を
// しません。四国を10日なら松山・高知・徳島・高松と拠点を移します。
//
// ここは制約の担当です。どのエリアが希望に合うか（＝意味）は ai.js が
// 選び、その並びを地理的に無理のない順に直し、日数を割り振るのがここ。

import { estimateMinutes } from "./feasibility.js";

/** 1日に回れるスポット数の目安。ペースで変えます。 */
// 1日あたりの行き先の数。
//
// 以前は 3 / 4 / 5 でした。実際に使うと「せっかく行ったのに、
// 昼過ぎで予定が終わってしまう」という形になりがちです。移動と
// 滞在で入りきらないぶんは verify.js が後ろから削るので、
// ここは多めに出しておくほうが、結果として1日が埋まります。
export const SPOTS_PER_DAY = { relaxed: 4, balanced: 5, packed: 7 };

/** そのエリアだけで無理なく過ごせる日数（収録スポット数から）。 */
export function capacityDays(spotCount, perDay = 4) {
  return Math.max(1, Math.ceil(spotCount / Math.max(2, perDay - 1)));
}

/**
 * 何エリアを回るのが自然か。
 * 2日にひとつを目安にしつつ、移動ばかりにならないよう上限を置きます。
 */
export function suggestRegionCount(days, maxRegions = 4) {
  if (days <= 2) return 1;
  return Math.min(maxRegions, Math.max(1, Math.ceil(days / 2)));
}

const stationOf = (region) => ({
  lat: region.stationLat, lng: region.stationLng,
  name: region.station || region.name,
  // 国をここで落とすと、国際線の上乗せが効かなくなります
  country: region.country ?? "日本",
});

/**
 * 回る順を、実際の移動距離が短くなるように並べ替えます。
 * エリア数は多くても4件なので、全順列を試して差し支えありません。
 */
export function orderRegions(regions, { origin, end, travelFn = estimateMinutes }) {
  if (regions.length <= 1) return [...regions];
  const idx = regions.map((_, i) => i);
  let best = null;
  for (const perm of permutations(idx)) {
    let cost = 0;
    let prev = origin;
    for (const i of perm) {
      const st = stationOf(regions[i]);
      cost += travelFn(prev, st);
      prev = st;
    }
    if (end) cost += travelFn(prev, end);
    if (!best || cost < best.cost) best = { cost, perm };
  }
  return best.perm.map((i) => regions[i]);
}

function* permutations(arr) {
  if (arr.length <= 1) { yield [...arr]; return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

/**
 * 日数をエリアに割り振ります。
 *
 * 収録スポットが少ないエリアに長く留めても手持ち無沙汰になるだけなので、
 * まず各エリアの「持ちこたえられる日数」で上限を切り、余りを収録数の
 * 多い順に配ります。最後は必ず全日が埋まります。
 */
export function allocateDays(regions, days, spotCounts, perDay = 4) {
  const n = regions.length;
  if (n === 0) return [];
  if (n === 1) return [days];
  const caps = regions.map((r, i) =>
    capacityDays(spotCounts[i] ?? 0, perDay));
  const alloc = new Array(n).fill(1);
  let left = days - n;
  // まず上限まで、収録の多いエリアから
  const order = regions.map((_, i) => i)
    .sort((a, b) => (spotCounts[b] ?? 0) - (spotCounts[a] ?? 0));
  while (left > 0) {
    let placed = false;
    for (const i of order) {
      if (left <= 0) break;
      if (alloc[i] < caps[i]) { alloc[i]++; left--; placed = true; }
    }
    if (!placed) break;    // どこも上限。残りは最後に足す
  }
  // 上限を超えてもまだ余るなら、順に1日ずつ配ります。
  // 最初のエリアにまとめて足すと「徳島に4日、あとは2日ずつ」のような
  // 偏った旅程になり、収録の少ないエリアで手持ち無沙汰の日が出ます。
  for (let i = 0; left > 0; i = (i + 1) % n, left--) alloc[i]++;
  return alloc;
}

/**
 * 滞在計画を作ります。
 *
 * @param {Array<{region:object, spots:Array}>} chosen 訪れるエリア（AIの並び）
 * @param {object} opts
 * @returns {{stays:Array, baseByDay:Array, regionByDay:Array}}
 */
export function planStays(chosen, { days, origin, end, pace = "balanced",
                                   travelFn = estimateMinutes } = {}) {
  const perDay = SPOTS_PER_DAY[pace] ?? 4;
  const regions = orderRegions(chosen.map((c) => c.region), { origin, end, travelFn });
  const byId = new Map(chosen.map((c) => [c.region.id, c]));
  const counts = regions.map((r) => byId.get(r.id)?.spots?.length ?? 0);
  const alloc = allocateDays(regions, days, counts, perDay);

  const stays = [];
  const baseByDay = [];
  const regionByDay = [];
  let day = 0;
  for (const [i, region] of regions.entries()) {
    const nDays = alloc[i];
    const stay = { region, station: stationOf(region), dayFrom: day,
                   dayTo: day + nDays - 1, days: nDays,
                   spots: byId.get(region.id)?.spots ?? [] };
    stays.push(stay);
    for (let d = 0; d < nDays; d++) {
      baseByDay.push(stay.station);
      regionByDay.push(region);
      day++;
    }
  }
  return { stays, baseByDay, regionByDay, perDay };
}

/** その日のエリア。 */
export function regionOfDay(stays, dayIndex) {
  for (const s of stays) {
    if (dayIndex >= s.dayFrom && dayIndex <= s.dayTo) return s.region;
  }
  return stays.at(-1)?.region ?? null;
}

/**
 * エリア名の並びを、見出しに使える短さにまとめます。
 * 4エリアを「・」で全部つなぐと、見出しが説明文になってしまいます。
 */
export function joinAreaNames(names) {
  const list = [...new Set(names.filter(Boolean))];
  if (list.length <= 3) return list.join("・");
  return `${list[0]}〜${list.at(-1)}ほか${list.length}エリア`;
}
