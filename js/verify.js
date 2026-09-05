// AI が出した案を、実際の時刻で検証する。
//
// 流れは「AIが案を出す → ここで検証 → 問題を理由付きで返す → AIが直す」。
// 検証結果は人間向けの文章ではなく構造化データにしてあります。そのまま
// 画面にも出せるし、次のプロンプトにも入れられるからです。
//
// ここが「もっともらしいが実行できない旅程」を止める最後の砦なので、
// 判定はすべて具体的な時刻に基づいて行い、推測はしません。
//
// 時計は「日」を意識して進みます。これが無いと、9泊10日の旅程が
// 10日間ぶっ通しの1日として扱われ、深夜も観光し続ける計算になります
// （実際にそうなっていました）。夜になったら宿に入り、翌朝また動き出す。

import { TUNING } from "./config.js";
import { hoursFor } from "./hours.js";
import {
  REJECT, addMinutes, atHour, estimateMinutes, haversineKm,
  profileOf,
} from "./feasibility.js";

const LUNCH = [11.5, 14.0];
const DINNER = [17.5, 20.0];
const hourOf = (d) => d.getHours() + d.getMinutes() / 60;

function nextDayAt(d, hour) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() + 1);
  return new Date(x.getTime() + hour * 3600000);
}

/**
 * 提案された訪問順を、時刻を進めながら検証します。
 *
 * @param {Array<object>} spots  訪問順に並んだスポット
 * @param {object} ctx
 * @param {{lat,lng,name}} ctx.start   出発地点（初日の拠点）
 * @param {Date}   ctx.startAt         出発時刻
 * @param {{lat,lng,name}} ctx.end     旅の終点
 * @param {Date}   ctx.endBy           終点に着くべき時刻
 * @param {number} [ctx.nights]        泊数。0 なら日帰り
 * @param {Array<{lat,lng,name}>} [ctx.baseByDay] 日ごとの拠点（宿の最寄り）
 * @param {number} [ctx.dayStartHour]  行動を始める時刻
 * @param {number} [ctx.dayEndHour]    行動を終える時刻
 * @param {string} [ctx.pace]
 * @param {(a,b)=>number} [ctx.travelFn]
 * @returns {{ok:boolean, issues:Array, visits:Array, meals:Array,
 *            nightsUsed:number, daysUsed:number, moves:Array,
 *            underfilled:{days:number}|null, arriveEnd:Date|null,
 *            slackMin:number}}
 */
export function verifyOrder(spots, ctx) {
  const travelFn = ctx.travelFn ?? estimateMinutes;
  const pace = ctx.pace ?? "balanced";
  const nights = Math.max(0, ctx.nights ?? 0);
  const dayStartHour = ctx.dayStartHour ?? TUNING.dayStartHour;
  const dayEndHour = ctx.dayEndHour ?? TUNING.dayEndHour;
  const baseByDay = ctx.baseByDay ?? [];

  const issues = [];
  const visits = [];
  const meals = [];
  const moves = [];   // 日をまたぐ拠点の移り変わり（別エリアへ渡る日）

  let clock = new Date(ctx.startAt);
  let cur = ctx.start;
  let dayIndex = 0;
  let hadLunch = false;
  let hadDinner = false;
  let visitsToday = 0;
  let arrivedAtNight = false;

  const isLastDay = () => dayIndex >= nights;
  const dayLimit = () => atHour(clock, dayEndHour);

  /** 深夜・早朝の到着。その時刻から見学は始められません。 */
  const atNight = (d) => hourOf(d) >= 22 || hourOf(d) < 6;

  /** 夜を越えて翌朝へ。宿が別エリアなら、その移動もここで時間を使います。 */
  function advanceDay() {
    // その日の夕食をまだ取っていなければ、宿に入る前に確保します。
    if (!hadDinner && visitsToday) {
      const at = hourOf(clock) < DINNER[0] ? atHour(clock, DINNER[0]) : clock;
      if (hourOf(at) <= DINNER[1]) {
        meals.push({ kind: "dinner", start: new Date(at),
                     end: addMinutes(at, TUNING.mealMin), day: dayIndex });
      }
    }
    const prevBase = baseByDay[dayIndex] ?? cur;
    dayIndex++;
    clock = nextDayAt(clock, dayStartHour);
    const base = baseByDay[dayIndex] ?? prevBase;
    // 拠点が同じ日に「移動」を作らないこと。距離0でも推定は数分を返すため、
    // 座標で比べます（毎朝「徳島駅 → 徳島駅」が出ていました）。
    const moved = Math.abs(prevBase.lat - base.lat) > 1e-6
      || Math.abs(prevBase.lng - base.lng) > 1e-6;
    const transfer = moved ? Math.round(travelFn(prevBase, base)) : 0;
    if (transfer > 0) {
      moves.push({ day: dayIndex, from: prevBase, to: base, minutes: transfer,
                   start: new Date(clock), end: addMinutes(clock, transfer) });
      clock = addMinutes(clock, transfer);
    }
    cur = base;
    hadLunch = false;
    hadDinner = false;
    visitsToday = 0;
  }

  /** いまの時刻・いまの日で、このスポットに行けるか。 */
  function attempt(spot) {
    const prof = profileOf(spot, pace);
    const travel = Math.round(travelFn(cur, spot));
    let arrive = addMinutes(clock, travel);
    let wait = 0;

    // その日の開き方。定休日・年末年始・冬期休業・曜日ごとの時間、
    // そして最終入場まで、hours.js が一箇所で決めます。
    const day = hoursFor(spot, arrive, pace);
    if (day.closed) {
      return { kind: "closed", prof,
        issue: { spotId: spot.id, name: spot.name, reason: REJECT.CLOSED_TODAY,
                 detail: `${spot.name}は${fmtDate(arrive)}が`
                   + `${day.reason}です。` } };
    }

    if (!day.alwaysOpen) {
      if (arrive < day.open) {
        wait = Math.round((day.open - arrive) / 60000);
        if (wait > TUNING.maxWaitMin) {
          return { kind: "issue",
            issue: { spotId: spot.id, name: spot.name,
                     reason: REJECT.WAIT_TOO_LONG,
                     detail: `${spot.name}の開館は${fmtTime(day.open)}で、`
                       + `${fmtTime(arrive)}到着では${wait}分待つことになります。` } };
        }
        arrive = new Date(day.open);
      }
      if (arrive >= day.close) {
        return { kind: "late", prof,
          issue: { spotId: spot.id, name: spot.name, reason: REJECT.TOO_LATE,
                   detail: `${spot.name}は${fmtTime(day.close)}に閉まりますが、`
                     + `到着は${fmtTime(arrive)}になります。` } };
      }
      // 「営業中」と「入場できる」は別です。ここを閉館時刻で通すと、
      // 現地で「開いているのに入れない」旅程ができあがります。
      if (day.lastEntry && arrive > day.lastEntry) {
        return { kind: "late", prof,
          issue: { spotId: spot.id, name: spot.name,
                   reason: REJECT.AFTER_LAST_ENTRY,
                   detail: `${spot.name}の最終入場は${fmtTime(day.lastEntry)}`
                     + `（閉館${fmtTime(day.close)}）で、`
                     + `到着は${fmtTime(arrive)}になります。` } };
      }
      if (addMinutes(arrive, prof.dwell) > day.close) {
        return { kind: "late", prof,
          issue: { spotId: spot.id, name: spot.name, reason: REJECT.TOO_LATE,
                   detail: `${spot.name}は${fmtTime(day.close)}閉館のため、`
                     + `${fmtTime(arrive)}から${prof.dwell}分の見学は収まりません。` } };
      }
    }

    const end = addMinutes(arrive, prof.dwell);
    // 泊まりの旅で、その日の行動終了時刻を越えるなら「今日はここまで」。
    // 最終日は帰りの期限のほうが厳しいので、この判定はしません。
    if (!isLastDay() && end > dayLimit()) {
      return { kind: "dayFull", prof,
        issue: { spotId: spot.id, name: spot.name, reason: REJECT.DAY_FULL,
                 detail: `${spot.name}の見学を終えるのは${fmtTime(end)}で、`
                   + `その日の行動時間（${fmtHour(dayEndHour)}まで）を越えます。` } };
    }
    return { kind: "ok", prof, arrive, end, travel, wait,
             km: haversineKm(cur, spot) };
  }

  // 到着が深夜・早朝なら、朝まで待ちます。
  // これが無いと、長距離の移動で夜中に着いた瞬間から見学を始める計算になり、
  // 「開館まで7時間待ち」で候補が全部落ちていました。
  if (atNight(clock)) {
    if (hourOf(clock) >= 22 && nights > 0) {
      // 夜に着いた → その晩は宿。翌朝から動きます
      advanceDay();
    } else {
      // 早朝に着いた → 同じ日の行動開始時刻まで待ちます
      clock = atHour(clock, dayStartHour);
    }
    arrivedAtNight = true;
  }

  // 日付のずれを合わせます。
  //
  // 長距離の移動では、着いたときにはもう翌日になっています。それでも
  // 「1日目」のまま数えると、旅程の日数が暦より1日多くなり、帰る便より
  // 後ろに宿泊が入ります（実際にそうなりました）。
  // 出発日からの経過日数で数え直します。
  if (ctx.day0) {
    const startOfDay = (d) => new Date(d).setHours(0, 0, 0, 0);
    const shift = Math.round(
      (startOfDay(clock) - startOfDay(ctx.day0)) / 86400000);
    dayIndex = Math.min(nights, Math.max(dayIndex, shift));
    cur = baseByDay[dayIndex] ?? cur;
  }

  for (const spot of spots) {
    // そのスポットを回る日が決まっている（＝どのエリアに滞在している日か）
    // なら、そこまで日を進めます。これが無いと、拠点は徳島のままで
    // 高松のスポットを回る、という旅程ができてしまいます。
    const floor = ctx.dayFloorById?.get(spot.id) ?? 0;
    while (dayIndex < floor && dayIndex < nights) advanceDay();

    // 食事の時間を、検証の時点で確保します。あとから空きに差し込む方式だと
    // 予定が詰まっている日には食事が消え、逆に押し込むと帰りの便に
    // 間に合わなくなります。最初から時間を取っておけば、どちらも起きません。
    takeMeals();

    let out = attempt(spot);

    // 今日はもう無理でも、明日がある旅なら明日に回します。
    //
    // 無条件に日を進めると、朝いちの定休日1件で丸一日を捨ててしまいます。
    // 逆にまったく進めないと、夕方に1件閉館しただけで、以降の候補が
    // 同じ時刻のまま全滅します（実際にそうなっていました）。
    // そこで「その日の行動時間を越えた」ときは必ず翌日へ、
    // 個々の閉館・定休日は午後遅く（14時以降）に限って翌日へ回します。
    const lateInDay = hourOf(clock) >= 14;
    const worthTomorrow = out.kind === "dayFull"
      || ((out.kind === "late" || out.kind === "closed")
          && visitsToday > 0 && lateInDay);
    if (worthTomorrow && !isLastDay()) {
      advanceDay();
      takeMeals();
      out = attempt(spot);
    }

    if (out.kind !== "ok") {
      issues.push(out.issue);
      continue;
    }

    visits.push({ spot, arrive: out.arrive, end: out.end, travel: out.travel,
                  wait: out.wait, km: out.km, dwell: out.prof.dwell,
                  fee: out.prof.fee, estimated: out.prof.estimated,
                  day: dayIndex });
    clock = out.end;
    cur = spot;
    visitsToday++;
  }

  // 見学後に昼どきへ入った場合の食事（帰りの前）
  if (visits.length) takeMeals();

  function takeMeals() {
    if (!hadLunch && hourOf(clock) >= LUNCH[0] && hourOf(clock) <= LUNCH[1]) {
      const end = addMinutes(clock, TUNING.mealMin);
      meals.push({ kind: "lunch", start: new Date(clock), end, day: dayIndex });
      clock = end;
      hadLunch = true;
    }
    const dinnerOk = ctx.allowDinner ?? !isLastDay();
    if (dinnerOk && !hadDinner
        && hourOf(clock) >= DINNER[0] && hourOf(clock) <= DINNER[1]) {
      const end = addMinutes(clock, TUNING.mealMin);
      meals.push({ kind: "dinner", start: new Date(clock), end, day: dayIndex });
      clock = end;
      hadDinner = true;
    }
  }

  // --- 終点に間に合うか -------------------------------------------------
  let arriveEnd = null;
  let slackMin = 0;
  let underfilled = null;

  if (ctx.end && ctx.endBy) {
    const back = Math.round(travelFn(cur, ctx.end));
    arriveEnd = addMinutes(clock, back);

    if (dayIndex < nights) {
      // 最終日より前に予定が尽きた。物理的には間に合いますが、
      // 「10日間の旅で4か所」のようなスカスカの旅程はここで検出します。
      const unused = nights - dayIndex;
      underfilled = { days: unused, plannedDays: dayIndex + 1,
                      totalDays: nights + 1 };
      slackMin = Math.max(0, Math.round((dayLimit() - clock) / 60000));
    } else {
      const limit = addMinutes(ctx.endBy, -TUNING.safetyBufferMin);
      slackMin = Math.round((limit - arriveEnd) / 60000);
      if (arriveEnd > limit) {
        const over = Math.round((arriveEnd - limit) / 60000);
        issues.push({
          spotId: null, name: ctx.end.name ?? "終点",
          reason: REJECT.CANNOT_FINISH,
          detail: `この順で回ると${ctx.end.name ?? "終点"}への到着が`
            + `${fmtTime(arriveEnd)}となり、期限（${fmtTime(ctx.endBy)}）を`
            + `${over}分超過します。立ち寄りを減らすか、近い場所に替えてください。`,
        });
      }
    }
  }

  return {
    ok: issues.length === 0, issues, visits, meals, moves, arrivedAtNight,
    daysUsed: dayIndex + 1, nightsUsed: dayIndex,
    underfilled, arriveEnd, slackMin,
  };
}

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * 検証結果を、次のプロンプトに入れる文章にまとめます。
 * モデルには「何がだめだったか」だけでなく「どうすれば直るか」も渡します。
 */
export function issuesToPrompt(result, spotsById) {
  const lines = [];
  if (result.issues.length) {
    lines.push("前回の案には次の問題がありました。これを解消してください。");
    for (const issue of result.issues) lines.push(`・${issue.detail}`);
  }
  if (result.underfilled) {
    const u = result.underfilled;
    lines.push(
      `・${u.totalDays}日間の旅程ですが、${u.plannedDays}日分しか予定が埋まって`
      + `いません。残り${u.days}日ぶんの立ち寄り先を必ず追加してください`
      + "（1日あたり3〜4か所が目安です）。");
  }
  if (!lines.length) return "";
  const dropped = result.issues.filter((i) => i.spotId).map((i) => i.spotId);
  if (dropped.length) {
    lines.push("",
      `次のIDは今回の日程では訪問できません。使わないでください: ${dropped.join(", ")}`);
  }
  if (result.visits.length) {
    const ok = result.visits.map((v) => v.spot.name).join("、");
    lines.push("", `時間的に問題なかったのは: ${ok}`);
  }
  void spotsById;
  return lines.join("\n");
}

/** 検証を通った訪問だけを残した並び。再計画しない場合の妥協案に使います。 */
export function keepFeasible(result) {
  return result.visits.map((v) => v.spot);
}

/**
 * 期限に間に合うまで、後ろから立ち寄りを削ります。
 *
 * これが無いと、検証で「終点に間に合わない」と分かっていても旅程が
 * 組まれてしまい、帰りの便が期限を過ぎて出発する表示になります。
 * 少ない立ち寄りでも実行できる旅程のほうが、多くて破綻した旅程よりましです。
 *
 * 予定が足りない（underfilled）のは削って直る種類の問題ではないので、
 * ここでは触りません。作り直しのプロンプトに回します。
 *
 * @returns {{result: object, spots: Array, dropped: Array}}
 */
export function trimToFit(spots, ctx, maxDrops = 12) {
  // 「必ず行く」と指定された場所は、時間が足りなくても削りません。
  // 削ってよいものと削ってはいけないものを混ぜると、利用者が
  // いちばん大事にしている予定から先に消えていきます。
  const pinned = new Set(ctx.pinnedIds ?? []);
  let current = [...spots];
  const dropped = [];
  const conflicts = [];
  let result = verifyOrder(current, ctx);

  for (let i = 0; i < maxDrops; i++) {
    // 個別スポットの問題（閉館など）は、その分だけ除いて再計算
    const bad = result.issues.filter((x) => x.spotId);
    const stuck = bad.filter((x) => pinned.has(x.spotId));
    for (const c of stuck) {
      if (!conflicts.some((x) => x.spotId === c.spotId)) conflicts.push(c);
    }
    const badIds = new Set(bad.filter((x) => !pinned.has(x.spotId))
      .map((x) => x.spotId));
    if (badIds.size) {
      const removed = current.filter((s) => badIds.has(s.id));
      dropped.push(...removed);
      current = current.filter((s) => !badIds.has(s.id));
      result = verifyOrder(current, ctx);
      continue;
    }
    // 終点に間に合わないなら、削ってよい立ち寄りを後ろから1件落とす
    const cannotFinish = result.issues.some(
      (x) => x.reason === REJECT.CANNOT_FINISH);
    if (!cannotFinish) break;
    const idx = lastIndexWhere(current, (s) => !pinned.has(s.id));
    if (idx < 0) break;            // 残りは全部「必ず行く」。これ以上は削れない
    dropped.push(current[idx]);
    current = [...current.slice(0, idx), ...current.slice(idx + 1)];
    result = verifyOrder(current, ctx);
  }
  return { result, spots: current, dropped, conflicts };
}

function lastIndexWhere(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

function fmtTime(d) {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 「9月12日(土)」。休みの理由を書くときに使います。 */
function fmtDate(d) {
  return `${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`;
}

function fmtHour(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return mm ? `${hh}:${String(mm).padStart(2, "0")}` : `${hh}時`;
}
