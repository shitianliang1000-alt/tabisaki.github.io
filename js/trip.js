// 旅の「かたち」を表すモデル。
//
// v2 では出発地に戻ることが暗黙の前提でした。実際の旅行は
//
//   日帰り     東京 → 鎌倉 → 江の島 → 東京      （出発地に戻る）
//   宿泊       東京 → 松本 → 上高地 → 松本の宿   （目的地で終わる）
//   片道       東京 → 名古屋 → 京都 → 大阪       （別の場所で終わる）
//
// と形が違うので、終点を独立させます。ここが分かれていないと、
// スケジューラは「帰りの便」を必ず入れてしまい、片道旅行が作れません。

/** @typedef {{name:string, lat:number, lng:number}} Place */

/**
 * 時刻の入力欄（"09:30"）と、内部で使う数（9.5）の変換。
 *
 * 1日の枠は端から時刻で扱います。長さ（9時間）だけでは「いつ動くのか」
 * が決まらず、同じ9時間でも7時発と10時発では開いている施設が変わります。
 */

/** "09:30" → 9.5。読めなければ null。 */
export function parseHourField(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h + min / 60;
}

/** 9.5 → "09:30"。 */
export function formatHourField(hour) {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export const END_MODES = /** @type {const} */ ({
  RETURN_TO_ORIGIN: "return-to-origin",   // 出発地に戻る
  END_AT_DESTINATION: "end-at-destination", // 最終目的地で終了
  RETURN_TO_OTHER: "return-to-other",     // 別の場所へ帰る
});

export const END_MODE_LABEL = {
  [END_MODES.RETURN_TO_ORIGIN]: "出発地に戻る",
  [END_MODES.END_AT_DESTINATION]: "最終目的地で終了",
  [END_MODES.RETURN_TO_OTHER]: "別の場所へ帰る",
};

/**
 * @param {object} init
 * @returns {object} 正規化された旅程条件
 */
export function makeTrip(init = {}) {
  return {
    origin: init.origin ?? null,
    /** 行き先を明示したい場合。null なら AI と検索で決める。 */
    destination: init.destination ?? null,
    endMode: init.endMode ?? END_MODES.RETURN_TO_ORIGIN,
    /** endMode が RETURN_TO_OTHER のときの帰着地 */
    returnTo: init.returnTo ?? null,
    departAt: init.departAt ?? null,
    /** 終点に着いていなければならない時刻 */
    arriveBy: init.arriveBy ?? null,
    /** [{ place, checkInBy }] 宿泊地。日数ぶん。 */
    lodging: init.lodging ?? [],
    /**
     * 絶対条件（hard constraints）。破ったら旅程として成立しないもの。
     *
     * 希望条件（下の note / interests / pace）と混ぜると、モデルが
     * 「静かな場所」と「18時までに帰る」を同じ重みで扱ってしまいます。
     * 前者は妥協できますが、後者は妥協できません。
     */
    must: {
      /** 必ず立ち寄るスポットID。検証で削られません。 */
      spotIds: init.must?.spotIds ?? [],
      /** 使わないスポットID。 */
      avoidSpotIds: init.must?.avoidSpotIds ?? [],
      /** 食事の時間を必ず確保するか。 */
      meals: init.must?.meals ?? true,
    },
    note: init.note ?? "",
    interests: init.interests ?? [],
    budgetYen: init.budgetYen ?? 15000,
    hiddenBias: init.hiddenBias ?? 0.5,
    /**
     * 1日のうち、観光にあてる時間帯。帰着時刻とは別のことです。
     *
     * 以前は「1日に動ける時間」を長さ（9時間）だけで聞いていました。
     * ただ、長さだけでは **いつ動くのか** が決まりません。同じ9時間でも
     * 7時発と10時発では、開いている施設も、その日に回れる場所も変わります。
     * 実際、旅程を組む側（verify.js）は端から時刻で考えていて、長さは
     * 件数の計算にしか使われず、時間帯は 9:00〜18:30 に固定されていました。
     * 聞き方を時刻に合わせ、そのまま旅程の枠として使います。
     */
    dayStartHour: Number.isFinite(init.dayStartHour) ? init.dayStartHour : 9,
    dayEndHour: Number.isFinite(init.dayEndHour) ? init.dayEndHour : 18.5,
    pace: init.pace ?? "balanced",
    /**
     * ペースを利用者が選んだかどうか。
     *
     * 選んでいれば、希望文からの推測で上書きしません。
     * 「もっとゆっくり」を押したのに何も変わらない、を防ぐためです。
     */
    paceChosen: init.pace !== undefined,
    /**
     * 混雑を避けて組むか。既定で有効です。
     * 順番を変えるだけで、行ける場所が減るわけではありません。
     */
    avoidCrowds: init.avoidCrowds ?? true,
    /** 人数。費用の概算に効きます。 */
    people: init.people ?? 1,
  };
}

/**
 * 旅の終点。ここに `arriveBy` までに着いている必要があります。
 * @returns {Place|null}
 */
export function endPlace(trip) {
  switch (trip.endMode) {
    case END_MODES.END_AT_DESTINATION:
      return trip.destination ?? null;
    case END_MODES.RETURN_TO_OTHER:
      return trip.returnTo ?? null;
    case END_MODES.RETURN_TO_ORIGIN:
    default:
      return trip.origin ?? null;
  }
}

/** 終点が出発地と同じか（＝帰りの移動が必要か）。 */
export function returnsToStart(trip) {
  const end = endPlace(trip);
  if (!end || !trip.origin) return false;
  return samePlace(end, trip.origin);
}

export function samePlace(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6;
}

/** 何泊か。0 は日帰り。 */
export function nightsOf(trip) {
  if (!trip.departAt || !trip.arriveBy) return 0;
  const a = startOfDay(trip.departAt);
  const b = startOfDay(trip.arriveBy);
  return Math.max(0, Math.round((b - a) / 86400000));
}

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

export function totalMinutes(trip) {
  if (!trip.departAt || !trip.arriveBy) return 0;
  return Math.floor((trip.arriveBy - trip.departAt) / 60000);
}

/**
 * 入力の不備を、直し方まで含めて日本語で返します。
 * 空配列なら旅程を組める状態です。
 */
export function validateTrip(trip) {
  const errors = [];
  if (!trip.origin) errors.push("出発地を指定してください。");
  if (!trip.departAt) errors.push("出発日時を指定してください。");
  if (!trip.arriveBy) errors.push("到着（帰着）日時を指定してください。");

  if (trip.departAt && trip.arriveBy && trip.arriveBy <= trip.departAt) {
    errors.push("到着日時は出発日時より後にしてください。");
  }
  if (trip.departAt && trip.arriveBy && totalMinutes(trip) < 150) {
    errors.push("旅程を組むには最低でも2時間半ほど必要です。");
  }
  if (trip.endMode === END_MODES.END_AT_DESTINATION && !trip.destination) {
    errors.push("「最終目的地で終了」を選んだ場合は、最終目的地を指定してください。");
  }
  if (trip.endMode === END_MODES.RETURN_TO_OTHER && !trip.returnTo) {
    errors.push("「別の場所へ帰る」を選んだ場合は、帰着地を指定してください。");
  }

  const both = (trip.must?.spotIds ?? [])
    .filter((id) => (trip.must?.avoidSpotIds ?? []).includes(id));
  if (both.length) {
    errors.push("同じ場所が「必ず行く」と「行かない」の両方に入っています。");
  }

  const nights = nightsOf(trip);
  if (nights > 0 && trip.lodging.length > 0 && trip.lodging.length < nights) {
    errors.push(`${nights}泊の旅程ですが、宿泊地が${trip.lodging.length}件しか`
      + "指定されていません。");
  }
  for (const [i, l] of trip.lodging.entries()) {
    if (!l?.place) errors.push(`${i + 1}泊目の宿泊地が未設定です。`);
    if (l?.checkInBy && trip.departAt && l.checkInBy <= trip.departAt) {
      errors.push(`${i + 1}泊目のチェックイン期限が出発日時より前になっています。`);
    }
  }
  return errors;
}

/**
 * その日の終点と、そこに着いているべき時刻。
 * 最終日は旅の終点、それ以外は宿。
 * @returns {{place: Place|null, by: Date|null, isFinal: boolean}}
 */
export function dayEnd(trip, dayIndex) {
  const nights = nightsOf(trip);
  if (dayIndex >= nights) {
    return { place: endPlace(trip), by: trip.arriveBy, isFinal: true };
  }
  const l = trip.lodging[dayIndex];
  if (!l?.place) return { place: null, by: null, isFinal: false };
  return { place: l.place, by: l.checkInBy ?? null, isFinal: false };
}
