// 費用の内訳。
//
// これまで「予算」を外していたのは、入場料しか数えておらず、
// 交通費も宿泊費も持っていなかったからです。合計が実態と何桁も違うのに
// 「予算内です」と出すのは、判断材料ではなく誤解の元でした。
//
// 交通費を距離から見積もれるようにしたので、内訳として出せる状態に
// なりました。実額ではないので「概算」とはっきり書きます。
// Routes API から運賃が取れた区間は、そちらを優先します。

import { TUNING } from "./config.js";

/**
 * 距離から公共交通の運賃を見積もります。
 *
 * 日本の鉄道は「初乗り + 距離逓減」なので、そのかたちに寄せています。
 * 長距離ほど1kmあたりが安くなる代わりに、新幹線の特急料金が乗ります。
 */
export function fareFor(km, { mode = "TRANSIT" } = {}) {
  if (!Number.isFinite(km) || km <= 0) return 0;
  if (mode === "WALK" || km < 1.2) return 0;
  if (km <= 3) return 150;
  if (km <= 10) return Math.round(150 + (km - 3) * 30);
  if (km <= 50) return Math.round(360 + (km - 10) * 22);
  if (km <= 150) return Math.round(1240 + (km - 50) * 18);   // 在来線＋特急
  // 新幹線帯。運賃＋特急料金をならした概算
  const rail = Math.round(3040 + (km - 150) * 20);
  if (km <= 700) return rail;
  // 700km を超えると空路が現実的になります。鉄道の式をそのまま伸ばすと
  // 東京〜パリが片道14万円を超え、実勢とかけ離れます。
  const air = Math.round(10000 + km * 8);
  return Math.min(rail, air);
}

const yen = (n) => Math.max(0, Math.round(n));

/**
 * 旅程の費用を項目ごとに積み上げます。
 *
 * @param {object} itin
 * @param {object} [opts]
 * @param {number} [opts.people] 人数（宿泊と入場に効きます）
 * @returns {{total:number, perPerson:number, rows:Array, estimated:boolean}}
 */
export function costBreakdown(itin, { people = 1 } = {}) {
  let transit = 0;
  let meals = 0;
  let admission = 0;
  let lodging = 0;
  let anyFare = false;

  for (const day of itin.days) {
    for (const item of day.items) {
      switch (item.kind) {
        case "transit": {
          if (typeof item.fareYen === "number") { transit += item.fareYen; anyFare = true; }
          else transit += fareFor(item.km ?? kmOf(item), { mode: item.walk ? "WALK" : "TRANSIT" });
          break;
        }
        case "meal": meals += item.costYen ?? TUNING.mealYen; break;
        case "spot": admission += item.costYen ?? 0; break;
        case "lodging": lodging += item.costYen ?? TUNING.lodgingYen; break;
        default: break;
      }
    }
  }

  const rows = [
    { key: "transit", label: "交通", yen: yen(transit * people),
      note: anyFare ? "一部は実際の運賃" : "距離からの概算" },
    { key: "meals", label: "食事", yen: yen(meals * people),
      note: `1食 ¥${TUNING.mealYen.toLocaleString()}で計算` },
    { key: "admission", label: "入場・拝観", yen: yen(admission * people),
      note: "収録の料金" },
    { key: "lodging", label: "宿泊", yen: yen(lodging * people),
      note: `1泊 ¥${TUNING.lodgingYen.toLocaleString()}で計算` },
  ].filter((r) => r.yen > 0);

  const total = rows.reduce((a, r) => a + r.yen, 0);
  return { total, perPerson: Math.round(total / Math.max(1, people)),
           rows, estimated: true };
}

/** 距離が入っていない移動の、座標からの補完。 */
function kmOf(item) {
  const a = item.from;
  const b = item.to;
  if (!a || !b) return 0;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
