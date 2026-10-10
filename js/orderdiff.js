// 回る順を変えたら、移動がどう変わったかを見せる。
//
// 並びを入れ替えると、旅程はまるごと組み直されます（app.js の
// reorderSpots）。時刻も移動も新しくなりますが、画面には新しい旅程が
// 出るだけで、**前と比べてどうなったのか**は書いてありませんでした。
// 「入れ替えたら得だったのか」が分からないと、試しに動かしてみる気に
// なれません。
//
// 比べるのは、旅行者が気にする3つだけです。
//
//   ・移動にかかる時間の合計（日ごと）
//   ・その日の予定が終わる時刻
//   ・その順では入らなくて、落ちた立ち寄り
//
// 区間1本ずつは比べません。順が変われば区間そのものが別物になるので、
// 「この区間は+12分」と言っても、前の旅程に同じ区間がありません。

const minutesOf = (item) =>
  Math.max(0, Math.round((new Date(item.end) - new Date(item.start)) / 60000));

const idOf = (item) => item.spotId ?? item.place?.id ?? null;

/** 1日ぶんの、移動の合計・終わる時刻・立ち寄り。 */
function daySummary(day) {
  const items = day?.items ?? [];
  const moveMin = items.filter((i) => i.kind === "transit")
    .reduce((a, i) => a + minutesOf(i), 0);
  const ends = items.map((i) => new Date(i.end ?? i.start))
    .filter((d) => Number.isFinite(d.getTime()));
  const end = ends.length ? new Date(Math.max(...ends)) : null;
  const spots = items.filter((i) => i.kind === "spot" && idOf(i))
    .map((i) => ({ id: idOf(i), name: i.title ?? i.place?.name ?? "" }));
  return { moveMin, end, spots };
}

/**
 * 組み直す前と後を比べます。
 *
 * @param {object} before 並べ替える前の旅程
 * @param {object} after  組み直した旅程
 * @returns {{moveBefore:number, moveAfter:number, deltaMin:number,
 *            days:Array, dropped:Array}|null} 比べられなければ null
 */
export function orderDiff(before, after) {
  const a = before?.days ?? [];
  const b = after?.days ?? [];
  if (!a.length || !b.length) return null;
  const days = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = daySummary(a[i]);
    const y = daySummary(b[i]);
    days.push({
      index: i,
      moveBefore: x.moveMin, moveAfter: y.moveMin,
      deltaMin: y.moveMin - x.moveMin,
      endBefore: x.end, endAfter: y.end,
      endDeltaMin: x.end && y.end ? Math.round((y.end - x.end) / 60000) : 0,
    });
  }
  const kept = new Set(b.flatMap((d) => daySummary(d).spots.map((s) => s.id)));
  const dropped = a.flatMap((d) => daySummary(d).spots)
    .filter((s) => !kept.has(s.id));
  const moveBefore = days.reduce((s, d) => s + d.moveBefore, 0);
  const moveAfter = days.reduce((s, d) => s + d.moveAfter, 0);
  return { moveBefore, moveAfter, deltaMin: moveAfter - moveBefore,
           days, dropped };
}

/** 95 → 「1時間35分」 */
export function fmtMinutes(min) {
  const m = Math.abs(Math.round(min));
  if (m < 60) return `${m}分`;
  return m % 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m / 60}時間`;
}

const fmtClock = (d) =>
  `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;

/** 差を「15分短く」「10分長く」「変わらず」で言います。 */
export function deltaWord(min, { less = "短く", more = "長く" } = {}) {
  if (!min) return "変わらず";
  return `${fmtMinutes(min)}${min < 0 ? less : more}`;
}

/**
 * 画面に出す行。いちばん上が見出しになります。
 *
 * @returns {{tone:"better"|"worse"|"same", head:string, lines:string[]}|null}
 */
export function describeOrderDiff(diff) {
  if (!diff) return null;
  const tone = diff.deltaMin < 0 ? "better"
    : diff.deltaMin > 0 ? "worse" : "same";
  const head = `移動の合計 ${fmtMinutes(diff.moveBefore)} → `
    + `${fmtMinutes(diff.moveAfter)}（${deltaWord(diff.deltaMin)}）`;
  const lines = [];
  const multi = diff.days.length > 1;
  for (const d of diff.days) {
    const parts = [];
    // 何日もある旅では、変わった日だけを書きます。
    if (multi && d.deltaMin) {
      parts.push(`移動 ${deltaWord(d.deltaMin)}`);
    }
    if (d.endBefore && d.endAfter && d.endDeltaMin) {
      parts.push(`終わり ${fmtClock(d.endBefore)} → ${fmtClock(d.endAfter)}`
        + `（${deltaWord(d.endDeltaMin, { less: "早く", more: "遅く" })}）`);
    }
    if (parts.length) {
      lines.push(multi ? `${d.index + 1}日目：${parts.join("・")}` : parts.join("・"));
    }
  }
  if (diff.dropped.length) {
    lines.push(`この順では入らず外れた場所：${diff.dropped.map((s) => s.name).join("、")}`);
  }
  return { tone, head, lines };
}
