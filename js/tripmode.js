// 旅行中モード — 開いたら、いきなり「次の一手」。
//
// 旅の当日に携帯で開くと、出てくるのは条件の入力と長い旅程です。
// 「今日の旅」（js/today.js）は旅程の上にありますが、分析や3案や
// 言葉で直す欄と同じ画面に並んでいて、片手で歩きながら探すものでは
// ありません。
//
// 旅行中モードは、ワンタップで画面を「次の予定」と「このあとの予定」
// だけにします。**端末に覚えておく**ので、閉じて開き直しても、
// そのまま旅行中の画面から始まります。旅が終われば自然に外れます。
//
// 覚えるのは、この端末の localStorage だけです。どこにも送りません。

import { freezeItinerary, thawItinerary } from "./history.js";

export const TRIP_MODE_KEY = "tabisaki.tripMode";

/** 最後の予定が終わってから、これだけ過ぎたら旅は終わったとみなします。 */
const AFTER_TRIP_MS = 6 * 3600000;

/** 旅の終わり（最後の予定の終わり、無ければ最終日）。 */
function tripEnd(itin) {
  const last = itin?.days?.at(-1);
  const end = last?.items?.at(-1)?.end ?? last?.date;
  const t = end ? new Date(end).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/** もう旅が終わっているか。 */
export function tripOver(itin, now = new Date()) {
  const end = tripEnd(itin);
  return end !== null && now.getTime() > end + AFTER_TRIP_MS;
}

/** 旅行中モードにした旅程を覚えます。 */
export function saveTripMode(itin, trip, storage = globalThis.localStorage) {
  try {
    storage?.setItem(TRIP_MODE_KEY, JSON.stringify({
      itin: freezeItinerary(itin), trip: freezeItinerary(trip ?? null),
    }));
    return true;
  } catch {
    // 空きが足りないときは覚えられません。いま開いている画面は
    // そのまま旅行中モードで動きます。
    return false;
  }
}

export function clearTripMode(storage = globalThis.localStorage) {
  try { storage?.removeItem(TRIP_MODE_KEY); } catch { /* 何もしません */ }
}

/**
 * 覚えている旅程。無い・読めない・旅が終わっているときは null
 * （終わっていたら、覚えていたものも消します）。
 *
 * @returns {{itin:object, trip:object|null}|null}
 */
export function loadTripMode(storage = globalThis.localStorage, now = new Date()) {
  let raw = null;
  try { raw = storage?.getItem(TRIP_MODE_KEY); } catch { return null; }
  if (!raw) return null;
  let doc = null;
  try { doc = JSON.parse(raw); } catch { /* 下で消します */ }
  const itin = doc?.itin ? thawItinerary(doc.itin) : null;
  if (!itin?.days?.length || tripOver(itin, now)) {
    clearTripMode(storage);
    return null;
  }
  return { itin, trip: doc.trip ? thawItinerary(doc.trip) : null };
}

/**
 * その日の、これから先の予定（いまの予定と次の予定は除きます。
 * そちらは大きく出ているので）。
 *
 * @param {object} step currentStep の結果
 * @returns {Array} 時刻順の予定
 */
export function laterToday(itin, step) {
  const items = itin?.days?.[step?.day]?.items ?? [];
  const skip = new Set([step?.current?.id, step?.next?.id].filter(Boolean));
  const from = step?.next?.start ?? step?.current?.end ?? null;
  return items.filter((i) => i.start && !skip.has(i.id)
    && (!from || new Date(i.start) >= new Date(from)));
}
