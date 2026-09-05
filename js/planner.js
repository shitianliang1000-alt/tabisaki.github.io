// 検証済みの訪問順を、画面に出せる時刻付きの旅程に組み立てる。
//
// 判定はすべて verify.js が済ませた後なので、ここは「並べる」ことに集中します。
// 食事と宿泊は、このアプリが在庫を持たない領域なので、時間枠だけ確保して
// 実際の店選びは Google マップ側に渡します（links.js）。
//
// 日をまたぐ旅では、その日の拠点（宿のあるエリア）が変わります。
// 変わる日の朝には移動が入り、夜の宿はその日のエリアに取ります。

import { TUNING } from "./config.js";
import { addMinutes, atHour, estimateMinutes, haversineKm, profileOf }
  from "./feasibility.js";
import { describeHours, hoursFor } from "./hours.js";
import { pickLodging } from "./lodging.js";
import { joinAreaNames, regionOfDay } from "./stays.js";
import { END_MODES, dayEnd, nightsOf, returnsToStart } from "./trip.js";

let seq = 0;
const nextId = () => `it-${++seq}`;

/**
 * 移動の項目に、公共交通の中身（路線・乗換・待ち時間）を足します。
 *
 * 分からないときは何も足しません。「乗換0回」と書いてしまうと、
 * 実際には乗り換えがあるのに直通だと読まれます。
 * 空欄のほうが、間違った断定より役に立ちます。
 */
function withTransit(item, transit) {
  if (!transit) return item;
  item.transit = transit;
  if (transit.headline) item.detail = `${item.detail}・${transit.headline}`;
  return item;
}

function freeTimeHint(region, minutes) {
  const g = new Set(region?.genres ?? []);
  if (minutes >= 150) {
    if (g.has("onsen")) return "温泉に浸かったり、宿でゆっくり過ごす時間に";
    if (g.has("sea")) return "海沿いを歩いたり、景色を眺めてのんびり";
    if (g.has("city") || g.has("food")) return "街歩き、カフェ、買い物などに";
    return "まとまった空き時間。周辺を自由に散策できます";
  }
  if (g.has("food")) return "お茶や食べ歩きに";
  return "お土産を見たり、カフェで休んだり";
}

/**
 * @param {object} input
 * @param {object} input.trip
 * @param {Array}  input.stays    planStays の結果（エリアと滞在日）
 * @param {Array}  input.visits   verifyOrder が返した visits（時刻・day 入り）
 * @param {Array}  input.meals    同上
 * @param {Array}  input.moves    日をまたぐ拠点移動
 * @param {Map}    input.reasons  spotId → 選定理由
 * @param {object} input.legs     { outbound, inbound } 実測または推定
 * @param {(a,b)=>number} [input.travelFn]
 */
export function buildItinerary(input) {
  const { trip, visits, reasons, legs } = input;
  const stays = input.stays?.length
    ? input.stays
    : [{ region: input.region, days: 1, dayFrom: 0, dayTo: 0,
         station: { lat: input.region.stationLat, lng: input.region.stationLng,
                    name: input.region.station } }];
  const meals = input.meals ?? [];
  const moves = input.moves ?? [];
  const travelFn = input.travelFn ?? estimateMinutes;
  // 区間の中身（路線・乗換・待ち時間）を引く関数。分からなければ null。
  // 「たぶんこの路線」で埋めるくらいなら、何も出さないほうが安全です。
  const legDetail = input.legDetail ?? (() => null);
  const nights = nightsOf(trip);
  const firstRegion = stays[0].region;
  const items = [];
  let totalCost = 0;
  /** 営業時間まわりの注意。同じ文が並ばないよう集合で持ちます。 */
  const hoursWarnings = new Set();

  // --- 往路 ---
  const outMin = legs?.outbound?.minutes
    ?? travelFn(trip.origin, stays[0].station);
  const arriveStation = addMinutes(trip.departAt, outMin);
  items.push(withTransit({
    id: nextId(), kind: "transit",
    start: trip.departAt, end: arriveStation,
    title: `${trip.origin.name} → ${firstRegion.station || firstRegion.name}`,
    // 「（推定）」は書きません。実測か推定かは、確からしさの印
    // （confidence.js）が別に出します。二重に書くと読みにくくなります。
    detail: `${legs?.outbound?.line ? legs.outbound.line + "・" : ""}約${outMin}分`,
    from: trip.origin,
    to: stays[0].station,
    routed: Boolean(legs?.outbound?.routed),
    km: haversineKm(trip.origin, stays[0].station),
    costYen: 0,
    reason: legs?.outbound?.routed
      ? "Google マップの経路検索による所要時間"
      : "経路APIを使えないため距離からの推定",
  }, legs?.outbound?.transit));

  // --- 日ごとに組み立てる ---
  const movesByDay = new Map(moves.map((m) => [m.day, m]));
  let prevEnd = arriveStation;
  // いまどこにいるか。区間の中身を引くには「どこから」が要ります。
  let cur = stays[0].station;

  for (let day = 0; day <= nights; day++) {
    const region = regionOfDay(stays, day) ?? firstRegion;

    // 拠点が変わる日は、朝いちで移動する
    const mv = movesByDay.get(day);
    if (mv) {
      items.push({
        id: nextId(), kind: "transit",
        start: mv.start, end: mv.end,
        title: `${mv.from.name ?? "拠点"} → ${mv.to.name ?? region.name}`,
        detail: `拠点を移します・約${mv.minutes}分`,
        from: mv.from, to: mv.to,
        routed: false, costYen: 0,
        km: haversineKm(mv.from, mv.to),
        reason: `${day + 1}日目から${region.name}を拠点にするため`,
      });
      prevEnd = mv.end;
      cur = mv.to;
    }

    // その日の食事と訪問を、時刻順に混ぜる
    const dayEntries = [
      ...meals.filter((m) => (m.day ?? 0) === day)
        .map((m) => ({ at: m.start, meal: m })),
      ...visits.filter((v) => (v.day ?? 0) === day)
        .map((v) => ({ at: addMinutes(v.arrive, -(v.travel + v.wait)), visit: v })),
    ].sort((a, b) => a.at - b.at);

    for (const entry of dayEntries) {
      if (entry.meal) {
        const m = entry.meal;
        items.push(mealItem(m.start, m.end,
          m.kind === "dinner" ? "夕食" : "昼食", region));
        totalCost += TUNING.mealYen;
        if (m.end > prevEnd) prevEnd = m.end;
        continue;
      }
      const v = entry.visit;
      if (v.travel > 0) {
        items.push(withTransit({
          id: nextId(), kind: "transit",
          start: addMinutes(v.arrive, -(v.travel + v.wait)),
          end: addMinutes(v.arrive, -v.wait),
          title: `${v.spot.name}へ移動`,
          detail: (v.travel <= 25 ? "徒歩" : "移動") + `約${v.travel}分`
            + (v.km ? `・約${v.km.toFixed(1)}km` : ""),
          from: cur, to: v.spot,
          walk: v.travel <= 25, km: v.km ?? 0,
          routed: Boolean(legs?.local?.routed),
          costYen: 0,
          reason: "検証済みの移動時間",
        }, legDetail(cur, v.spot)?.transit));
      }
      cur = v.spot;
      if (v.wait > 0) {
        items.push({
          id: nextId(), kind: "free",
          start: addMinutes(v.arrive, -v.wait), end: v.arrive,
          title: "自由時間",
          detail: `${v.spot.name}が開くまで約${v.wait}分`,
          costYen: 0, reason: "開館時刻に合わせた待ち時間",
        });
      }
      const prof = profileOf(v.spot, trip.pace);
      // その日の営業時間。閉館だけでなく最終入場も出します。
      // 「営業中」と「入場できる」は別で、旅程を狂わせるのは後者です。
      const day = hoursFor(v.spot, v.arrive, trip.pace);
      if (day.riskyNote) hoursWarnings.add(`${v.spot.name}: ${day.riskyNote}`);
      items.push({
        id: nextId(), kind: "spot",
        start: v.arrive, end: v.end,
        title: v.spot.name,
        detail: v.spot.description ?? "",
        spotId: v.spot.id,
        place: v.spot,
        costYen: prof.fee,
        estimated: prof.estimated,
        hoursText: describeHours(v.spot, v.arrive, trip.pace),
        hoursNote: day.note || null,
        lastEntry: day.lastEntry,
        reason: reasons?.get(v.spot.id) ?? "ご希望に合う場所です",
      });
      totalCost += prof.fee;
      prevEnd = v.end;
    }

    // 夜は、その日のエリアに泊まる。
    // ただし、まだ現地に着いていない夜（長距離の移動中）に宿は取れません。
    // 東京発パリ行きは17時間かかるので、最初の夜は機内です。
    if (day < nights) {
      const anchor = dayEntries.length ? prevEnd
        : atHour(new Date(trip.departAt.getTime() + day * 86400000),
                 TUNING.dayEndHour);
      if (anchor < arriveStation) {
        items.push({
          id: nextId(), kind: "free",
          start: anchor, end: addMinutes(anchor, 60),
          title: "移動中",
          detail: `${firstRegion.name}へ向かう途中です（機内・車内泊）`,
          costYen: 0,
          reason: "現地に着く前の夜のため、宿は取りません",
        });
      } else {
        pushLodging(items, trip, region, day, anchor, input.kb);
        totalCost += TUNING.lodgingYen;
      }
      prevEnd = anchor;
    }
  }

  // --- 復路 or 終点への移動 ---
  const lastRegion = regionOfDay(stays, nights) ?? firstRegion;
  const end = dayEnd(trip, nights);
  if (end.place) {
    const backMin = legs?.inbound?.minutes
      ?? travelFn(visits.at(-1)?.spot ?? trip.origin, end.place);
    const limit = addMinutes(trip.arriveBy, -TUNING.safetyBufferMin);
    const startBack = new Date(Math.max(prevEnd.getTime(),
                                        addMinutes(limit, -backMin).getTime()));
    // 帰りまでの空きに「自由時間」を置きます。ただし日はまたぎません。
    //
    // またぐと 23時間41分 の自由時間ができ、「いちばん長い1日は29時間」
    // という表示になっていました。夜をまたぐ空きは自由時間ではなく、
    // 「まだ予定を埋められていない日」です。そちらは
    // verify.js の underfilled が別に伝えます。
    const dayCap = atHour(prevEnd, TUNING.dayEndHour);
    const freeEnd = new Date(Math.min(
      startBack.getTime(),
      Math.max(dayCap.getTime(), prevEnd.getTime())));
    const gap = Math.round((freeEnd - prevEnd) / 60000);
    if (gap >= 15 && gap <= 8 * 60) {
      items.push({
        id: nextId(), kind: "free", start: prevEnd, end: freeEnd,
        title: "自由時間", detail: freeTimeHint(lastRegion, gap),
        costYen: 0, reason: "次の予定まで時間があるため",
      });
    }
    const label = returnsToStart(trip)
      ? `${lastRegion.station || lastRegion.name} → ${end.place.name}`
      : `${lastRegion.station || lastRegion.name} → ${end.place.name}（最終目的地）`;
    items.push({
      id: nextId(), kind: "transit",
      start: startBack, end: addMinutes(startBack, backMin),
      title: label,
      detail: `${legs?.inbound?.line ? legs.inbound.line + "・" : ""}約${backMin}分`
        + (legs?.inbound?.routed ? "" : "（推定）"),
      from: null, to: end.place,
      routed: Boolean(legs?.inbound?.routed),
      km: haversineKm(visits.at(-1)?.spot ?? lastRegion, end.place),
      costYen: 0,
      reason: trip.endMode === END_MODES.RETURN_TO_ORIGIN
        ? "帰着時刻に間に合う便" : "最終目的地に向かう便",
    });
  }

  // --- 日ごとに分ける ---
  const days = [];
  for (const item of items) {
    const key = new Date(item.start).setHours(0, 0, 0, 0);
    let day = days.find((d) => d.key === key);
    if (!day) { day = { key, date: new Date(item.start), items: [] }; days.push(day); }
    day.items.push(item);
  }
  days.sort((a, b) => a.key - b.key);
  for (const d of days) d.items.sort((a, b) => a.start - b.start);

  const spotCount = items.filter((i) => i.kind === "spot").length;
  const warnings = [];
  if (!spotCount) {
    warnings.push("時間が短く、立ち寄れる場所を組めませんでした。滞在時間を延ばしてください。");
  }
  if (!legs?.outbound?.routed) {
    warnings.push(legs?.routeError
      ? `移動時間は直線距離からの推定です（Routes API: ${legs.routeError}）。`
      : "移動時間は直線距離からの推定です。js/config.js に Maps API キーを"
        + "設定すると実際の経路になります。");
  }
  if (legs?.modeNote && legs?.local?.routed) {
    warnings.push(`${legs.modeNote}。`);
  }
  if (items.some((i) => i.kind === "spot" && i.estimated)) {
    warnings.push("一部スポットの営業時間・料金は分類ごとの目安です。訪問前に公式情報をご確認ください。");
  }

  const regionName = stays.map((s) => s.region.name).join("・");
  return {
    regionId: firstRegion.id, regionName,
    title: joinAreaNames(stays.map((s) => s.region.name)),
    prefecture: [...new Set(stays.map((s) => s.region.prefecture))].join("・"),
    stays: stays.map((s) => ({ id: s.region.id, name: s.region.name,
                               days: s.days, dayFrom: s.dayFrom })),
    days, totalCostYen: totalCost, spotCount, warnings,
    hoursWarnings: [...hoursWarnings],
    endMode: trip.endMode,
    usedRoutesApi: Boolean(legs?.outbound?.routed || legs?.local?.routed),
  };
}

function mealItem(start, end, title, region) {
  return {
    id: nextId(), kind: "meal", start, end, title,
    detail: `${region?.name ?? ""}で。お店は地図から選べます`,
    costYen: TUNING.mealYen,
    near: { lat: region?.lat, lng: region?.lng, regionName: region?.name },
    reason: title === "昼食" ? "昼の時間帯に差しかかったため" : "夕食の時間帯",
  };
}

function pushLodging(items, trip, region, dayIndex, after, kb) {
  const lodging = trip.lodging?.[dayIndex];
  // 宿はエリアの中心ではなく、人が集まる地点に取ります。
  // 中心座標は収録スポットの重心なので、富士山エリアなら山頂付近になります。
  const spot = pickLodging({ region, kb, explicit: lodging });
  const fallbackStart = atHour(after, TUNING.dayEndHour + 1);
  const start = lodging?.checkInBy
    ?? (fallbackStart > after ? fallbackStart : addMinutes(after, 30));
  items.push({
    id: nextId(), kind: "lodging",
    start, end: addMinutes(start, 60),
    title: `${spot.regionName}に宿泊`,
    detail: lodging?.place ? "" : `${spot.reason}。宿は地図から探せます（宿泊費は目安）`,
    costYen: TUNING.lodgingYen,
    place: lodging?.place ?? null,
    near: { lat: spot.place.lat, lng: spot.place.lng,
            regionName: spot.regionName },
    movedFrom: spot.movedFrom,
    checkIn: start,
    checkOut: addMinutes(start, 24 * 60),
    reason: spot.movedFrom
      ? `${spot.movedFrom}には宿が少ないため` : "翌日も旅が続くため",
  });
}
