// 「もっとゆっくりしたい」で旅程を直すテスト。
//
// いちばん大事な決めごとは、**AIに旅程を作り直させない**ことです。
// AIがやるのは「言われたことを、条件の書き換えに翻訳する」だけ。
// 組み立ては、これまでどおり verify.js と pipeline.js が行います。
//
// AIに新しい旅程を自由に作らせると、営業時間も移動時間も無視した、
// もっともらしいだけの旅程が返ってきます。それを防ぐ設計です。
//
// もうひとつ。AIキーが無くても動く必要があります。日本語の言い回しから
// 読み取れるぶんは、こちらで読み取ります。

import assert from "node:assert/strict";
import test from "node:test";

import { applyEdit, describeEdit, parseEdit, parseEditLocally }
  from "../js/edit.js";
import { makeTrip } from "../js/trip.js";

const d = (s) => new Date(s);

/** 松山の3泊4日を模した旅程。 */
const ITIN = {
  title: "松山・道後",
  days: [
    { date: d("2026-09-12T09:00"), items: [
      { id: "i1", kind: "spot", title: "松山城", spotId: "s1",
        place: { id: "s1", name: "松山城", category: "城",
                 genres: ["history"] } },
      { id: "i2", kind: "spot", title: "道後温泉本館", spotId: "s2",
        place: { id: "s2", name: "道後温泉本館", category: "温泉",
                 genres: ["onsen"] } },
    ] },
    { date: d("2026-09-13T09:00"), items: [
      { id: "i3", kind: "spot", title: "石手寺", spotId: "s3",
        place: { id: "s3", name: "石手寺", category: "寺院",
                 genres: ["history"] } },
    ] },
  ],
};

const TRIP = () => makeTrip({
  origin: { name: "東京駅", lat: 35.68, lng: 139.76 },
  departAt: d("2026-09-12T09:00"),
  arriveBy: d("2026-09-15T19:00"),
  note: "四国で温泉と歴史を楽しみたい",
  interests: ["onsen", "history"],
});

// --- 言い回しから読み取る（AIキーが無くても動く） -------------------------

test("「もっとゆっくり」でペースが変わる", () => {
  const p = parseEditLocally("もっとゆっくりしたい", ITIN);
  assert.equal(p.pace, "relaxed");
});

test("「もっと回りたい」で詰めこむ側に変わる", () => {
  assert.equal(parseEditLocally("もっとたくさん回りたい", ITIN).pace, "packed");
  assert.equal(parseEditLocally("もう少し詰めこんで", ITIN).pace, "packed");
});

test("「もう1泊」で日数が増える", () => {
  assert.equal(parseEditLocally("もう1泊増やしたい", ITIN).addNights, 1);
  assert.equal(parseEditLocally("2泊増やして", ITIN).addNights, 2);
  // 「3泊4日」のような、いまの日程の言い直しは日数の追加ではありません
  assert.equal(parseEditLocally("3泊4日のままでいい", ITIN).addNights, 0);
});

test("旅程に入っている場所の名前で、外せる", () => {
  const p = parseEditLocally("松山城は外して", ITIN);
  assert.deepEqual(p.remove, ["s1"]);
});

test("旅程に入っている場所の名前で、固定できる", () => {
  const p = parseEditLocally("道後温泉本館は絶対に行きたい", ITIN);
  assert.deepEqual(p.keep, ["s2"]);
});

test("旅程に無い名前は、外す指示にならない（勝手に消さない）", () => {
  const p = parseEditLocally("金閣寺は外して", ITIN);
  assert.deepEqual(p.remove, []);
  // 読み取れなかったことは、そう伝えます
  assert.ok(p.unresolved.includes("金閣寺"));
});

test("興味の増減を読み取る", () => {
  assert.deepEqual(parseEditLocally("温泉をもっと増やして", ITIN).addInterests,
                   ["onsen"]);
  assert.deepEqual(parseEditLocally("お寺は減らしたい", ITIN).dropInterests,
                   ["history"]);
});

test("「穴場」「定番」で混ぜかたが動く", () => {
  assert.ok(parseEditLocally("もっと穴場を", ITIN).hiddenBias > 0.5);
  assert.ok(parseEditLocally("定番だけでいい", ITIN).hiddenBias < 0.5);
});

test("「休憩を増やして」を読み取る", () => {
  assert.equal(parseEditLocally("途中で休憩を増やしてほしい", ITIN).moreRest,
               true);
});

test("何も読み取れなければ、空のパッチを返す（勝手に動かさない）", () => {
  const p = parseEditLocally("こんにちは", ITIN);
  assert.equal(p.pace, null);
  assert.equal(p.addNights, 0);
  assert.deepEqual(p.remove, []);
  assert.equal(p.empty, true);
});

// --- AIが返したパッチを、必ず検証する -------------------------------------

test("AIは旅程ではなくパッチだけを返し、それを検証してから使う", async () => {
  const call = async () => JSON.stringify({
    pace: "relaxed", addNights: 1, remove: ["s1"], keep: ["s2"],
    addInterests: ["onsen"], hiddenBias: 0.7, moreRest: true,
  });
  const p = await parseEdit("もっとゆっくり、松山城は外して", ITIN, { call });
  assert.equal(p.pace, "relaxed");
  assert.equal(p.addNights, 1);
  assert.deepEqual(p.remove, ["s1"]);
  assert.deepEqual(p.keep, ["s2"]);
  assert.equal(p.fromModel, true);
});

test("AIが旅程に無いIDを返しても、通さない", async () => {
  const call = async () => JSON.stringify({ remove: ["s1", "存在しないID"],
                                            keep: ["でたらめ"] });
  const p = await parseEdit("直して", ITIN, { call });
  assert.deepEqual(p.remove, ["s1"]);
  assert.deepEqual(p.keep, []);
});

test("AIがおかしな値を返しても、範囲に収める", async () => {
  const call = async () => JSON.stringify({
    pace: "超特急", addNights: 999, hiddenBias: 5, extendMinutes: -100000,
  });
  const p = await parseEdit("直して", ITIN, { call });
  assert.equal(p.pace, null, "知らないペースを通しています");
  assert.ok(p.addNights <= 14, `${p.addNights}泊 は増やしすぎです`);
  assert.ok(p.hiddenBias >= 0 && p.hiddenBias <= 1);
});

test("AIが答えられなくても、言い回しからの読み取りに落ちる", async () => {
  const call = async () => { throw new Error("キーがありません"); };
  const p = await parseEdit("もっとゆっくりしたい", ITIN, { call });
  assert.equal(p.pace, "relaxed");
  assert.equal(p.fromModel, false);
});

test("AIが壊れたJSONを返しても、落ちない", async () => {
  const call = async () => "{これはJSONではありません";
  const p = await parseEdit("もっとゆっくり", ITIN, { call });
  assert.equal(p.pace, "relaxed");
  assert.equal(p.fromModel, false);
});

// --- パッチを条件に適用する（ここは純粋な計算） ---------------------------

test("パッチを当てても、元の条件は壊れない", () => {
  const before = TRIP();
  const after = applyEdit({ pace: "relaxed" }, before);
  assert.equal(before.pace, "balanced", "元の条件を書き換えています");
  assert.equal(after.pace, "relaxed");
  assert.equal(after.origin, before.origin);
  assert.equal(+after.departAt, +before.departAt);
});

test("日数を増やすと、到着期限が後ろにずれる", () => {
  const before = TRIP();
  const after = applyEdit({ addNights: 2 }, before);
  assert.equal((after.arriveBy - before.arriveBy) / 86400000, 2);
});

test("外す指示は、避けるスポットとして残る（次も出てこない）", () => {
  const after = applyEdit({ remove: ["s1"] }, TRIP());
  assert.deepEqual(after.must.avoidSpotIds, ["s1"]);
});

test("固定する指示は、必ず行く場所として残る", () => {
  const after = applyEdit({ keep: ["s2"] }, TRIP());
  assert.deepEqual(after.must.spotIds, ["s2"]);
});

test("外すと固定が同じ場所に来たら、固定を優先する", () => {
  // 「松山城を外して」の後に「やっぱり松山城には行きたい」と言われた場合。
  // 消すほうを優先すると、行きたいと言った場所が二度と出てきません。
  const after = applyEdit({ remove: ["s1"], keep: ["s1"] }, TRIP());
  assert.deepEqual(after.must.spotIds, ["s1"]);
  assert.deepEqual(after.must.avoidSpotIds, []);
});

test("興味の増減が、条件に反映される", () => {
  const after = applyEdit({ addInterests: ["view"], dropInterests: ["history"] },
                          TRIP());
  assert.ok(after.interests.includes("view"));
  assert.ok(!after.interests.includes("history"));
  assert.ok(after.interests.includes("onsen"));
});

test("休憩を増やすと、ペースがゆるむ", () => {
  const after = applyEdit({ moreRest: true }, TRIP());
  assert.equal(after.pace, "relaxed");
});

// --- 何をしたかを、言葉で返す ---------------------------------------------

test("どう解釈したかを日本語で返す（黙って書き換えない）", () => {
  const text = describeEdit({ pace: "relaxed", addNights: 1, remove: ["s1"] },
                            ITIN);
  assert.match(text, /ゆっくり/);
  assert.match(text, /1泊/);
  assert.match(text, /松山城/);
});

test("何も読み取れなかったときは、そう言う", () => {
  const text = describeEdit(parseEditLocally("あああ", ITIN), ITIN);
  assert.match(text, /読み取れ/);
});

test("場所の名前に含まれる語を、ジャンルの指示と取り違えない", () => {
  // 「道後温泉本館は外して」は、その1か所を外す指示であって、
  // 「温泉を減らして」ではありません。名前の中の語に反応すると、
  // 温泉が目的の旅から温泉が消えます。
  const p = parseEditLocally("道後温泉本館は外して", ITIN);
  assert.deepEqual(p.remove, ["s2"]);
  assert.deepEqual(p.dropInterests, [], "名前の中の「温泉」に反応しています");
});

test("場所を外しつつ、ジャンルの指示も同時にできる", () => {
  const p = parseEditLocally("松山城は外して、温泉をもっと増やして", ITIN);
  assert.deepEqual(p.remove, ["s1"]);
  assert.deepEqual(p.addInterests, ["onsen"]);
});
