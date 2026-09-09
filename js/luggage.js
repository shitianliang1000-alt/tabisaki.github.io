// 荷物をどうするか。
//
// 泊まりの旅で、旅程はたいてい「ホテル → 観光 → 観光 → ホテル」と
// 書かれます。でも実際には、チェックアウトのあとは荷物を持って
// 歩くことになります。スーツケースを引いて石段を登るのと、
// 手ぶらで登るのは、まったく別の旅です。
//
// 旅程の時刻は合っているのに現地でつらい、という差がここに出ます。
//
// ここでやるのは「どこで手放せるか」を出すことだけです。
// コインロッカーの空き状況までは分かりませんし、分からないものを
// 分かると言わないのが、このアプリの方針です。

/** 荷物を持って行くのがつらい分類と、その理由。 */
const HARD_WITH_BAGS = {
  山: "登り道です", 登山: "登山道です", 丘: "坂と階段があります",
  高原: "歩く距離があります", 渓谷: "足場が整っていない道があります",
  滝: "遊歩道を歩きます", 海岸: "砂浜では車輪が使えません",
  漁港: "段差があります", 史跡: "屋外を歩きます",
  スキー場: "雪道です", 温泉: "館内に持ち込めないことがあります",
  ロープウェイ: "乗り場まで歩きます", 城: "石段があります",
  寺院: "石段や砂利道があります", 神社: "石段や砂利道があります",
  国立公園: "歩く距離があります", 国定公園: "歩く距離があります",
  町並み: "石畳や坂があります",
};

/** 泊まりで、宿を出たあとにまだ観光がある日があるか。 */
export function needsLuggagePlan(itin) {
  return luggagePlanFor(itin).days.length > 0;
}

/**
 * 荷物をどうするかの案。
 *
 * @returns {{days:Array, summary:string}}
 */
export function luggagePlanFor(itin) {
  const days = Array.isArray(itin?.days) ? itin.days : [];
  const out = [];

  // 前の日に宿があり、その翌日にまだ観光がある日を探します。
  for (let i = 1; i < days.length; i++) {
    const stayed = (days[i - 1].items ?? [])
      .find((x) => x.kind === "lodging");
    if (!stayed) continue;

    const spots = (days[i].items ?? [])
      .filter((x) => x.kind === "spot" && x.place);
    if (!spots.length) continue;

    // その日にまた同じ宿へ戻るなら、持ち歩く必要はありません
    const staysAgain = (days[i].items ?? []).some((x) => x.kind === "lodging");

    const hard = spots
      .filter((s) => HARD_WITH_BAGS[s.place.category])
      .map((s) => ({ name: s.place.name,
                     why: HARD_WITH_BAGS[s.place.category] }));

    const where = stayed.near?.regionName ?? "宿";
    out.push({
      day: i,
      staysAgain,
      spots: spots.map((s) => s.place.name),
      hard,
      options: [
        { kind: "hotel", label: "宿に預ける",
          text: `${where}の宿は、チェックアウト後も荷物を預かってくれる`
            + "ことがほとんどです。まずここを当たってください。無料です。" },
        { kind: "locker", label: "駅のコインロッカー",
          text: "大きい荷物は数が少なく、休日は昼前に埋まります。"
            + "朝のうちに入れておくのが確実です。" },
        { kind: "counter", label: "手荷物預かり所",
          text: "主要駅や観光案内所にあります。ロッカーより大きい荷物も"
            + "預かってもらえますが、閉まる時刻が早いことがあります。" },
        { kind: "carry", label: "持ち歩く",
          text: hard.length
            ? `${hard.map((h) => h.name).join("・")}では、`
              + "荷物があると負担になります。おすすめしません。"
            : "この日の行き先なら、持ち歩いても大きな支障はなさそうです。" },
      ],
    });
  }

  return { days: out, summary: summarize(out) };
}

function summarize(days) {
  if (!days.length) return "";
  const hard = days.flatMap((d) => d.hard);
  const head = `${days.map((d) => `${d.day + 1}日目`).join("・")}は、`
    + "宿を出たあとにも立ち寄り先があります。";
  if (!hard.length) {
    return `${head}荷物は宿に預けるか、駅のロッカーに入れておくと`
      + "身軽に回れます。";
  }
  return `${head}${hard.slice(0, 2).map((h) => `${h.name}（${h.why}）`).join("・")}`
    + `${hard.length > 2 ? "ほか" : ""}があるので、`
    + "荷物は宿かロッカーに置いていくことをおすすめします。";
}
