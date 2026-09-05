// 旅行中モード — 「いま、次に何をすればいいのか」だけを出す。
//
// 旅の当日、長い旅程はほとんど役に立ちません。スクロールして自分の
// 現在地を探すあいだに、電車は出ていきます。当日に知りたいのは
// 一点だけです。
//
//   次はどこへ、いつ向かえばいいのか。
//
// そして遅れているときは、もう一点。
//
//   どこを削れば、帰りに間に合うのか。
//
// どちらも数えれば決まることなので、AIには聞きません。
// 「たぶん大丈夫です」と言われても、現地では何の役にも立ちません。

const MIN = 60000;

/** 何分か（切り上げず、素直に丸めます）。 */
const minutesBetween = (a, b) => Math.round((b - a) / MIN);

/**
 * いまの日付にあたる日を取り出します。
 *
 * @returns {{index:number, date:Date|null, items:Array, phase:string}}
 *   phase … "before"（旅の前）/ "during" / "after"（旅の後）
 */
export function todayOf(itin, now = new Date()) {
  const days = Array.isArray(itin?.days) ? itin.days : [];
  if (!days.length) {
    return { index: -1, date: null, items: [], phase: "none" };
  }
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const i = days.findIndex((d) => d.date && sameDay(new Date(d.date), now));
  if (i >= 0) {
    return { index: i, date: days[i].date, items: days[i].items ?? [],
             phase: "during" };
  }
  const first = new Date(days[0].date);
  const last = new Date(days.at(-1).date);
  if (now < first) {
    return { index: 0, date: days[0].date, items: days[0].items ?? [],
             phase: "before" };
  }
  if (now > last) {
    return { index: days.length - 1, date: days.at(-1).date,
             items: days.at(-1).items ?? [], phase: "after" };
  }
  // 旅の途中だが、その日の予定が無い（移動だけの日など）
  return { index: 0, date: days[0].date, items: days[0].items ?? [],
           phase: "during" };
}

/**
 * いま何をしていて、次は何か。
 *
 * @returns {{status:string, current:object|null, next:object|null,
 *            minutesUntil:number|null, day:number}}
 *   status … "during"（予定の最中）/ "waiting"（次まで空き）/
 *            "before"（その日の開始前）/ "done"（その日は終わり）
 */
export function currentStep(itin, now = new Date()) {
  const today = todayOf(itin, now);
  const items = (today.items ?? []).filter((i) => i.start && i.end);
  const base = { day: today.index, phase: today.phase,
                 current: null, next: null, minutesUntil: null };
  if (!items.length) return { ...base, status: "done" };

  const current = items.find((i) => now >= i.start && now < i.end) ?? null;
  const next = items.find((i) => i.start > now) ?? null;

  if (current) {
    return { ...base, status: "during", current, next,
             minutesUntil: minutesBetween(now, current.end) };
  }
  if (next) {
    const status = now < items[0].start ? "before" : "waiting";
    return { ...base, status, current: null, next,
             minutesUntil: minutesBetween(now, next.start) };
  }
  return { ...base, status: "done" };
}

const fmt = (d) => `${String(d.getHours()).padStart(2, "0")}:`
  + String(d.getMinutes()).padStart(2, "0");

/** 次の一手を、そのまま読める一文にします。 */
export function describeNext(step) {
  if (!step?.next) {
    return step?.status === "done"
      ? "今日の予定はここまでです。おつかれさまでした。"
      : "次の予定はありません。";
  }
  const n = step.next;
  const at = fmt(n.start);
  const inMin = step.minutesUntil;

  if (step.status === "during") {
    return `いまは「${step.current.title}」。`
      + `あと${inMin}分で出て、${at} から「${n.title}」です。`;
  }
  if (inMin <= 0) return `「${n.title}」の時間です（${at}）。`;
  if (inMin <= 60) return `${at} から「${n.title}」。あと${inMin}分です。`;
  return `次は ${at} から「${n.title}」です。`;
}

// --- 遅れの回復 -------------------------------------------------------------

/** これ以上は削らない（削りすぎると、行った意味がなくなります）。 */
const MIN_STAY_MIN = 25;
/** 1か所から削ってよい割合の上限。 */
const MAX_TRIM_RATIO = 0.4;

/**
 * 遅れを数え、どこを削れば帰りに間に合うかを出します。
 *
 * 削るのは **これから行く場所だけ** です。過ぎた予定は削れません。
 * 削っても間に合わないときは、間に合わないと言います。
 * できないことをできると言うのは、当日いちばんやってはいけないことです。
 *
 * @param {object} itin
 * @param {Date} now
 * @param {{endBy?:Date, arrivedAtId?:string, lateMin?:number}} ctx
 *   arrivedAtId … **いま着いた**予定のid。画面の「着いた」を押したときに
 *     渡します。その予定の予定開始時刻との差が、そのまま遅れです。
 *     （「いまどこにいるか」ではなく「いま着いたか」で数えるのは、
 *       滞在中の人を遅れていると誤判定しないためです）
 *   lateMin  … 遅れが分かっているなら、そのまま渡せます
 * @returns {{lateMin:number, actions:Array, enough:boolean, summary:string}}
 */
export function catchUp(itin, now = new Date(), ctx = {}) {
  const today = todayOf(itin, now);
  const items = (today.items ?? []).filter((i) => i.start && i.end);
  if (!items.length) {
    return { lateMin: 0, actions: [], enough: true,
             summary: "今日の予定はありません。" };
  }

  // 1. どれくらい遅れているか
  let lateMin = Number.isFinite(ctx.lateMin) ? ctx.lateMin : 0;
  if (!lateMin && ctx.arrivedAtId) {
    const at = items.find((i) => i.id === ctx.arrivedAtId);
    // 着くはずだった時刻と、実際に着いた時刻の差
    if (at && now > at.start) lateMin = minutesBetween(at.start, now);
  }
  if (lateMin <= 0) {
    return { lateMin: 0, actions: [], enough: true,
             summary: "予定どおりです。" };
  }

  // 2. どれだけ取り戻せばよいか。
  //    帰着の期限までに余裕があれば、そのぶんは削らなくて済みます。
  const plannedEnd = items.at(-1).end;
  const slackMin = ctx.endBy ? minutesBetween(plannedEnd, new Date(ctx.endBy)) : 0;
  const needMin = Math.max(0, lateMin - Math.max(0, slackMin));

  if (needMin === 0) {
    return { lateMin, actions: [], enough: true,
             summary: `${lateMin}分 遅れていますが、帰りまでの余裕`
               + `（${slackMin}分）で吸収できます。急がなくて大丈夫です。` };
  }

  // 3. これから行く場所から、削れるぶんを集めます。
  //    長い滞在から順に削るのは、削られた側の損失が相対的に小さいためです。
  const ahead = items.filter((i) => i.start > now && i.kind === "spot");
  const trims = ahead.map((i) => {
    const stay = minutesBetween(i.start, i.end);
    const canTrim = Math.max(0,
      Math.min(Math.floor(stay * MAX_TRIM_RATIO), stay - MIN_STAY_MIN));
    return { item: i, stay, canTrim };
  }).filter((t) => t.canTrim > 0)
    .sort((a, b) => b.canTrim - a.canTrim);

  const actions = [];
  let saved = 0;
  for (const t of trims) {
    if (saved >= needMin) break;
    const take = Math.min(t.canTrim, needMin - saved);
    saved += take;
    actions.push({
      kind: "shorten", itemId: t.item.id,
      spotId: t.item.spotId ?? t.item.place?.id ?? null,
      savesMin: take,
      text: `「${t.item.title}」を ${take}分 短くする`
        + `（${t.stay}分 → ${t.stay - take}分）`,
    });
  }

  // 4. それでも足りなければ、立ち寄りを外すしかありません。
  if (saved < needMin) {
    const dropable = ahead
      .filter((i) => !actions.some((a) => a.itemId === i.id))
      .concat(ahead.filter((i) => actions.some((a) => a.itemId === i.id)))
      .slice(-1);
    for (const i of dropable) {
      const stay = minutesBetween(i.start, i.end);
      if (saved >= needMin) break;
      saved += stay;
      actions.push({
        kind: "drop", itemId: i.id,
        spotId: i.spotId ?? i.place?.id ?? null,
        savesMin: stay,
        text: `「${i.title}」を外す（${stay}分）`,
      });
    }
  }

  const enough = saved >= needMin;
  const arriveBy = ctx.endBy ? fmt(new Date(ctx.endBy)) : "";
  const summary = enough
    ? `${lateMin}分 遅れています。${actions.map((a) => a.text).join("、")}と、`
      + (arriveBy ? `${arriveBy}着を保てます。` : "帰りに間に合います。")
    : `${lateMin}分 遅れています。これから行く場所をすべて削っても`
      + `${needMin - saved}分 足りず、${arriveBy || "帰りの期限"}には`
      + "間に合いません。帰りの便を遅らせるか、"
      + "残りの立ち寄りをあきらめる必要があります。";

  return { lateMin, needMin, actions, enough, summary };
}
