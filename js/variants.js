// 3案を出して、選べるようにする。
//
// 旅行に「唯一の正解」はありません。同じ希望でも、ゆっくり2か所と
// 詰めて6か所では、向いている人が違います。1案だけ出して
// 「これが最適です」と言うより、3案並べて選んでもらうほうが正直です。
//
// ただし、**どれがおすすめかは言います**。3つ並べて放り出すのは、
// 選ぶ手間を押しつけているだけです。おすすめは score.js が数えた点で
// 決めます（AIには決めさせません）。
//
// 変えるのは「ペース」と「定番と穴場のまぜかた」の2つだけです。
// 日程も、必ず行く場所も、出発地も動かしません。そこは利用者が
// 決めたことで、案の違いではありません。

export const VARIANTS = {
  relaxed: {
    key: "relaxed", icon: "🌿", label: "ゆったり",
    blurb: "立ち寄りを絞って、1か所を長く。移動を減らします。",
    pace: "relaxed", hiddenBias: 0.35,
  },
  classic: {
    key: "classic", icon: "⭐", label: "王道",
    blurb: "定番を中心に、無理のない数で回ります。",
    pace: "balanced", hiddenBias: 0.25,
  },
  explore: {
    key: "explore", icon: "🗺", label: "探索",
    blurb: "穴場を多めに、数も多めに。歩く距離は増えます。",
    pace: "packed", hiddenBias: 0.75,
  },
};

/**
 * 案ごとの条件を作ります。元の条件は書き換えません。
 * @returns {Array<{key:string, variant:object, trip:object}>}
 */
export function tripsFor(trip) {
  return Object.values(VARIANTS).map((v) => ({
    key: v.key,
    variant: v,
    trip: {
      ...trip,
      // 「必ず行く」「行かない」は利用者が決めたことなので、そのまま運びます
      must: {
        ...trip.must,
        spotIds: [...(trip.must?.spotIds ?? [])],
        avoidSpotIds: [...(trip.must?.avoidSpotIds ?? [])],
      },
      interests: [...(trip.interests ?? [])],
      dayStartHour: trip.dayStartHour,
      dayEndHour: trip.dayEndHour,
      pace: v.pace,
      paceChosen: true,
      hiddenBias: v.hiddenBias,
    },
  }));
}

/** 疲労がこれを超えたら、点が高くてもおすすめにしません。 */
const TOO_HARD = 80;

/**
 * どれをおすすめにするか。
 *
 * 点がいちばん高いものを選びますが、**疲労が過密の案は外します**。
 * 「回れる数が多い＝良い」ではありません。人にはきつい旅程を
 * おすすめとして出すのは無責任です。
 *
 * 全部が過密なら、そのなかで点が高いものを出しつつ、そう言います。
 */
export function recommendOf(plans) {
  const list = (plans ?? []).filter((p) => p?.itin);
  if (!list.length) return null;

  const score = (p) => p.itin?.score?.total ?? 0;
  const fatigue = (p) => p.itin?.score?.fatigue ?? 0;
  const ok = list.filter((p) => fatigue(p) < TOO_HARD);
  const pool = ok.length ? ok : list;
  const best = pool.slice().sort((a, b) => score(b) - score(a))[0];

  const v = VARIANTS[best.key];
  const reason = ok.length
    ? `${v?.label ?? "この案"}が、いちばん無理がありません`
      + `（${score(best)}点）。${v?.blurb ?? ""}`
    : `どの案も詰まっています。そのなかでは${v?.label ?? "この案"}が`
      + `いちばん余裕がありますが（${score(best)}点）、`
      + "日程を延ばすか、立ち寄りを減らすことをおすすめします。";
  return { ...best, reason, allHard: ok.length === 0 };
}

/**
 * 3案の「違い」を、実際に出来上がった旅程から拾います。
 *
 * 「ゆったり／王道／探索」という名前だけでは、何が違うのかが
 * 分かりません。名前の説明（blurb）も書いてありますが、それは
 * **作る前の方針**であって、出来上がったものとは限りません。
 * 3案を並べて実際に比べ、いちばん際立っている点を1つだけ言います。
 *
 * 同じ言葉が2つの案に付かないよう、強い順に1回ずつ割り当てます。
 * 全部同じ結果になった案には、何も付けません（無理に違いを
 * 作ると、無い差を有るように見せることになります）。
 *
 * @returns {Map<string, string>} key → 一言
 */
export function distinguishOf(plans) {
  const list = (plans ?? []).filter((p) => p?.itin);
  const out = new Map();
  if (list.length < 2) return out;

  const spots = (p) => p.itin?.spotCount ?? 0;
  const move = (p) => (p.itin?.days ?? []).flatMap((d) => d?.items ?? [])
    .filter((i) => i.kind === "transit")
    .reduce((a, i) => a + Math.max(0, Math.round((i.end - i.start) / 60000)), 0);
  const hidden = (p) => (p.itin?.days ?? []).flatMap((d) => d?.items ?? [])
    .filter((i) => i.spot?.fame_tier === "hidden").length;

  // 「いちばん◯◯」は、他とはっきり差があるときだけ言います。
  // 1か所differ・5分differで「いちばん多い」と書くと、選ぶ側を
  // 迷わせるだけです。
  const claims = [
    { get: move, best: "min", gap: 20, text: "移動がいちばん短い" },
    { get: spots, best: "max", gap: 1, text: "いちばん多く回れる" },
    { get: hidden, best: "max", gap: 1, text: "穴場がいちばん多い" },
  ];
  for (const c of claims) {
    const vals = list.map((p) => ({ p, v: c.get(p) }));
    vals.sort((a, b) => c.best === "min" ? a.v - b.v : b.v - a.v);
    const top = vals[0];
    const next = vals.find((x) => x.p !== top.p);
    if (!next || out.has(top.p.key)) continue;
    if (Math.abs(top.v - next.v) < c.gap) continue;
    out.set(top.p.key, c.text);
  }
  return out;
}

/** 案のカードに出す一行。何か所・移動・自由時間。 */
export function summaryOf(itin) {
  const all = (itin?.days ?? []).flatMap((d) => d?.items ?? []);
  const min = (kind) => all.filter((i) => i.kind === kind)
    .reduce((a, i) => a + Math.max(0, Math.round((i.end - i.start) / 60000)), 0);
  const parts = [`${itin?.spotCount ?? 0}か所`];
  const move = min("transit");
  if (move) parts.push(`移動 ${fmt(move)}`);
  const free = min("free");
  if (free) parts.push(`自由時間 ${fmt(free)}`);
  return parts.join(" · ");
}

function fmt(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h ? `${h}時間${mm ? `${mm}分` : ""}` : `${mm}分`;
}
