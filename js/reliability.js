// この旅程は、どこまで確かめてあるか。
//
// このアプリの値打ちは「AIが旅程を書けること」ではありません。書くだけなら
// どこでもできます。**実際に行けるかどうかを確かめてあること**が違いです。
// ところが、確かめた事実は旅程の中に散らばっていて、画面からは見えません。
// 見えなければ、無いのと同じです。
//
// ここでは、散らばっている事実を1か所に集めて数えます。作り直しません。
// 判定はすでに verify.js（時刻）・hours.js（営業時間）・routes.js（移動）が
// 済ませています。ここがするのは、**数えて、言葉にする**ことだけです。
//
//   移動時間  実際の時刻表から取れた区間は、いくつか
//   営業時間  収録の実データで確かめた場所は、いくつか
//   帰り      帰着の期限まで、どれくらい余裕があるか
//   休み      休みの日に当たっている場所はないか
//
// 星の数は「良い旅程か」ではなく「**どこまで裏が取れているか**」です。
// 良い旅程かどうかは別の物差し（score.js の無理のなさ）で出しています。

import { slackLevel } from "./score.js";

/** 移動の出どころ。区間の中身から見分けます。 */
export function travelSource(item) {
  if (!item || item.kind !== "transit") return null;
  if (item.yahoo) return { key: "yahoo", label: "Yahoo!路線情報" };
  if (item.routed) return { key: "routes", label: "Googleの経路" };
  return { key: "estimate", label: "距離からの推定" };
}

const pct = (a, b) => (b > 0 ? a / b : 1);

/**
 * 旅程の裏の取れ具合。
 *
 * @param {object} itin
 * @returns {{stars:number, level:"high"|"mixed"|"low", summary:string,
 *            checks:Array<{ok:boolean, label:string, detail:string}>}}
 */
export function tripReliability(itin) {
  const items = (itin?.days ?? []).flatMap((d) => d?.items ?? []);
  const moves = items.filter((i) => i.kind === "transit");
  const spots = items.filter((i) => i.kind === "spot");

  const realMoves = moves.filter((i) => travelSource(i)?.key !== "estimate");
  const realHours = spots.filter((s) => s.estimated !== true);
  const slack = slackLevel(itin?.score?.slackMin ?? itin?.slackMin);
  const closedRisk = (itin?.hoursWarnings ?? []).length;

  const checks = [
    {
      ok: moves.length > 0 && realMoves.length === moves.length,
      label: "移動時間",
      detail: moves.length
        ? `${moves.length}区間のうち${realMoves.length}区間は実際の便から。`
          + (realMoves.length < moves.length
            ? `残り${moves.length - realMoves.length}区間は距離からの目安です。`
            : "")
        : "移動がありません。",
    },
    {
      ok: spots.length > 0 && realHours.length === spots.length,
      label: "営業時間",
      detail: spots.length
        ? `${spots.length}か所のうち${realHours.length}か所は収録の実データ。`
          + (realHours.length < spots.length
            ? `残り${spots.length - realHours.length}か所は分類ごとの目安です。`
            : "")
        : "立ち寄り先がありません。",
    },
    {
      ok: slack.level === "safe",
      label: "帰りの余裕",
      detail: slack.text,
    },
    {
      ok: closedRisk === 0,
      label: "休みの日",
      detail: closedRisk
        ? `${closedRisk}か所に、休みの可能性の注意が出ています。`
        : "休みに当たりそうな場所はありません。",
    },
  ];

  // 星は、移動と営業時間の裏の取れ具合が主です。帰りの余裕と休みは、
  // 崩れたときだけ引きます（そこは「確かめた結果、危ない」なので、
  // 確かめていないこととは意味が違います）。
  const base = pct(realMoves.length, moves.length) * 0.6
    + pct(realHours.length, spots.length) * 0.4;
  const penalty = (slack.level === "risky" ? 0.25
    : slack.level === "tight" ? 0.1 : 0) + (closedRisk ? 0.1 : 0);
  const stars = Math.max(1, Math.min(5, Math.round((base - penalty) * 5)));
  const level = stars >= 4 ? "high" : stars >= 3 ? "mixed" : "low";

  const summary = level === "high"
    ? "実際の便と営業時間で確かめてあります。"
    : level === "mixed"
      ? "一部は目安のままです。時間に余裕を持ってお出かけください。"
      : "確かめられていない部分が多く残っています。";

  return { stars, level, summary, checks };
}
