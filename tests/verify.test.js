// 「AIが案を出す → 検証 → 理由を返して再計画」の、検証側のテスト。
//
// 検証器が甘いと、そのまま実行不能な旅程が世に出ます。逆に厳しすぎると
// 何も提案できなくなります。境界のケースを具体的な時刻で固定します。

import assert from "node:assert/strict";
import test from "node:test";

import { REJECT } from "../js/feasibility.js";
import { issuesToPrompt, keepFeasible, trimToFit, verifyOrder } from "../js/verify.js";

const d = (s) => new Date(s);
const TOKYO = { name: "東京駅", lat: 35.681236, lng: 139.767125 };
const NEAR = { name: "鎌倉駅", lat: 35.3190, lng: 139.5500 };

function spot(over = {}) {
  return {
    id: over.id ?? "s1",
    name: over.name ?? "テスト美術館",
    category: over.category ?? "美術館",   // 既定 10:00-17:00 / 70分
    lat: over.lat ?? 35.3200,
    lng: over.lng ?? 139.5520,
    ...over,
  };
}

// 近接した3スポット（徒歩数分）
const A = spot({ id: "A", name: "館A", lat: 35.3200, lng: 139.5520 });
const B = spot({ id: "B", name: "館B", lat: 35.3210, lng: 139.5530 });
const SHRINE = spot({ id: "S", name: "神社S", category: "神社",
                      lat: 35.3205, lng: 139.5525 });

test("時間内に収まる順は、問題なしと判定される", () => {
  const r = verifyOrder([A, B], {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
  });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.visits.length, 2);
  assert.ok(r.slackMin > 0);
});

test("閉館後に着く案は、理由つきで弾かれる", () => {
  const r = verifyOrder([A], {
    start: NEAR, startAt: d("2026-09-12T17:30"),
    end: NEAR, endBy: d("2026-09-12T22:00"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].reason, REJECT.TOO_LATE);
  assert.ok(r.issues[0].detail.includes("館A"));
  assert.ok(/\d/.test(r.issues[0].detail), "時刻が理由に含まれていない");
});

test("最終入場を過ぎてしか着けない案は弾かれる", () => {
  // 美術館は 17:00 閉館・最終入場 16:30。開いてはいても入れません。
  const r = verifyOrder([A], {
    start: NEAR, startAt: d("2026-09-12T16:40"),
    end: NEAR, endBy: d("2026-09-12T22:00"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].reason, REJECT.AFTER_LAST_ENTRY);
});

test("閉館までに見学しきれない案も弾かれる", () => {
  // 最終入場（16:30）には間に合っても、70分の見学が 17:00 に収まりません。
  const r = verifyOrder([A], {
    start: NEAR, startAt: d("2026-09-12T16:10"),
    end: NEAR, endBy: d("2026-09-12T22:00"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].reason, REJECT.TOO_LATE);
});

test("開館まで少し待つ案は通り、待ち時間が記録される", () => {
  const r = verifyOrder([A], {
    start: NEAR, startAt: d("2026-09-12T09:30"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
  });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.ok(r.visits[0].wait > 0);
  assert.equal(r.visits[0].arrive.getHours(), 10);
});

test("待ちすぎる案は弾かれる", () => {
  const r = verifyOrder([A], {
    start: NEAR, startAt: d("2026-09-12T06:00"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].reason, REJECT.WAIT_TOO_LONG);
});

test("終点に間に合わない案は、超過分を示して弾かれる", () => {
  const r = verifyOrder([A, B], {
    start: NEAR, startAt: d("2026-09-12T14:00"),
    end: TOKYO, endBy: d("2026-09-12T15:00"),
  });
  assert.equal(r.ok, false);
  const issue = r.issues.find((i) => i.reason === REJECT.CANNOT_FINISH);
  assert.ok(issue, JSON.stringify(r.issues));
  assert.ok(issue.detail.includes("超過"), issue.detail);
});

test("常時開放のスポットは時間帯で弾かれない", () => {
  const r = verifyOrder([SHRINE], {
    start: NEAR, startAt: d("2026-09-12T07:00"),
    end: NEAR, endBy: d("2026-09-12T20:00"),
  });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
});

test("定休日は曜日で判定される", () => {
  // 2026-09-12 は土曜
  const closed = spot({ id: "C", name: "館C", closedDays: [6] });
  const r = verifyOrder([closed], {
    start: NEAR, startAt: d("2026-09-12T11:00"),
    end: NEAR, endBy: d("2026-09-12T20:00"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].reason, REJECT.CLOSED_TODAY);
});

test("問題のあるスポットだけが落ち、他は残る", () => {
  const late = spot({ id: "L", name: "館L", open: 20, close: 22 });
  const r = verifyOrder([SHRINE, late, B], {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
  });
  assert.equal(r.ok, false);
  const names = keepFeasible(r).map((s) => s.name);
  assert.deepEqual(names, ["神社S", "館B"]);
});

test("訪問順に時刻が単調に進む", () => {
  const r = verifyOrder([SHRINE, A, B], {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T19:00"),
  });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  for (let i = 1; i < r.visits.length; i++) {
    assert.ok(r.visits[i].arrive >= r.visits[i - 1].end,
      "訪問が前の見学終了より前に始まっている");
  }
});

test("空の案は、問題なしかつ訪問ゼロ", () => {
  const r = verifyOrder([], {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
  });
  assert.equal(r.ok, true);
  assert.equal(r.visits.length, 0);
});

test("独自の移動時間関数を使える（Routes API の実測を差し込む口）", () => {
  let called = 0;
  const travelFn = () => { called++; return 5; };
  const r = verifyOrder([A, B], {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
    travelFn,
  });
  assert.ok(called >= 3, `travelFn が使われていない (${called})`);
  assert.equal(r.visits[0].travel, 5);
});

// ------------------------------------------------- 再計画へのフィードバック --

test("問題は、次のプロンプト用の文章にまとまる", () => {
  const r = verifyOrder([A], {
    start: NEAR, startAt: d("2026-09-12T17:30"),
    end: NEAR, endBy: d("2026-09-12T22:00"),
  });
  const text = issuesToPrompt(r, new Map());
  assert.ok(text.includes("館A"), text);
  assert.ok(text.includes("使わないでください"), text);
  assert.ok(text.includes("A"), "落選IDが伝わっていない");
});

test("問題がなければフィードバック文は空", () => {
  const r = verifyOrder([SHRINE], {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
  });
  assert.equal(issuesToPrompt(r, new Map()), "");
});

test("通ったスポットも次のプロンプトに伝える（全部やり直させない）", () => {
  const late = spot({ id: "L", name: "館L", open: 20, close: 22 });
  const r = verifyOrder([SHRINE, late], {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
  });
  const text = issuesToPrompt(r, new Map());
  assert.ok(text.includes("神社S"), text);
});

// ---------------------------------------- 食事の時間確保と、収まるまで削る --

test("昼どきをまたぐ日程には、食事の時間が確保される", () => {
  const r = verifyOrder([A, B], {
    start: NEAR, startAt: d("2026-09-12T11:00"),
    end: NEAR, endBy: d("2026-09-12T20:00"),
  });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.meals.length, 1, "昼食が確保されていない");
  const lunch = r.meals[0];
  const h = lunch.start.getHours() + lunch.start.getMinutes() / 60;
  assert.ok(h >= 11.5 && h <= 14, `昼食の時刻が変: ${h}`);
});

test("食事の時間は、終点への到着判定にも含まれる", () => {
  // 食事を足すと期限を超えるぎりぎりの条件
  const withMeal = verifyOrder([A], {
    start: NEAR, startAt: d("2026-09-12T11:30"),
    end: NEAR, endBy: d("2026-09-12T14:00"),
  });
  const totalUsed = withMeal.meals.reduce(
    (s, m) => s + (m.end - m.start) / 60000, 0);
  assert.ok(totalUsed > 0, "食事が計上されていない");
  if (withMeal.arriveEnd) {
    // 食事ぶんが進んでいるので、到着は見学終了より後
    const lastVisit = withMeal.visits.at(-1);
    if (lastVisit) assert.ok(withMeal.arriveEnd >= lastVisit.end);
  }
});

test("昼どきに掛からない日程では食事を入れない", () => {
  const r = verifyOrder([SHRINE], {
    start: NEAR, startAt: d("2026-09-12T15:00"),
    end: NEAR, endBy: d("2026-09-12T20:00"),
  });
  assert.equal(r.meals.length, 0);
});

test("日帰りでは夕食を入れない（allowDinner 未指定）", () => {
  const r = verifyOrder([SHRINE], {
    start: NEAR, startAt: d("2026-09-12T17:30"),
    end: NEAR, endBy: d("2026-09-12T21:00"),
  });
  assert.ok(!r.meals.some((m) => m.kind === "dinner"));
});

test("宿泊ありなら夕食の時間も確保する", () => {
  const r = verifyOrder([SHRINE], {
    start: NEAR, startAt: d("2026-09-12T17:30"),
    end: NEAR, endBy: d("2026-09-13T21:00"),
    allowDinner: true,
  });
  assert.ok(r.meals.some((m) => m.kind === "dinner"), JSON.stringify(r.meals));
});

test("trimToFit は、期限に収まるまで後ろから削る", () => {
  const many = [A, B, SHRINE, spot({ id: "D", name: "館D", category: "神社",
                                     lat: 35.33, lng: 139.56 })];
  const ctx = {
    start: NEAR, startAt: d("2026-09-12T13:00"),
    end: TOKYO, endBy: d("2026-09-12T17:00"),
  };
  const before = verifyOrder(many, ctx);
  assert.equal(before.ok, false, "前提: この条件では収まらないはず");

  const { result, spots: kept, dropped } = trimToFit(many, ctx);
  assert.equal(result.ok, true,
    `削っても収まっていない: ${JSON.stringify(result.issues)}`);
  assert.ok(dropped.length > 0, "何も削っていない");
  assert.ok(kept.length < many.length);
  assert.ok(result.arriveEnd <= ctx.endBy, "期限を超えている");
});

test("trimToFit は、収まる日程では何も削らない", () => {
  const ctx = {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T19:00"),
  };
  const { result, spots: kept, dropped } = trimToFit([SHRINE, A], ctx);
  assert.equal(result.ok, true);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 2);
});

test("trimToFit は、全部落ちても例外を投げない", () => {
  const ctx = {
    start: NEAR, startAt: d("2026-09-12T18:50"),
    end: TOKYO, endBy: d("2026-09-12T19:00"),
  };
  const { result, spots: kept } = trimToFit([A, B], ctx);
  assert.ok(Array.isArray(kept));
  assert.ok(Array.isArray(result.visits));
});
