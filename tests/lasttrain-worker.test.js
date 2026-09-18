// 中継が「終電」を聞けるか。
//
// 終電は Yahoo!路線情報の検索欄にあります。番号は推測ではなく、
// 画面の HTML そのものから読みました。
//
//   <input type="radio" name="type" value="1"><label>出発</label>
//   <input type="radio" name="type" value="4"><label>到着</label>
//   <input type="radio" name="type" value="3"><label>始発</label>
//   <input type="radio" name="type" value="2"><label>終電</label>
//
// 実際に小田原→東京を type=2 で引くと、見出しが「終電」になり、
// 22:58発と22:56発が返ります（tests/fixtures/yahoo-odawara-tokyo-last.html）。
//
// ここで確かめたいのは2つです。
//
//   ① 頼まれたときだけ type=2 を立てること（既定は変えない）
//   ② 終電では「いちばん早く着く便」ではなく「いちばん遅く出る便」を
//      採ること。取り違えると、2分早い嘘になります

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import worker from "../server/worker.js";

const ORIGIN = "https://tabisaki.example";
const html = await readFile(
  new URL("./fixtures/yahoo-odawara-tokyo-last.html", import.meta.url), "utf8");

/**
 * Yahoo!の代わり。呼ばれたURLを控えて、保存した画面を返します。
 *
 * 本物には行きません。**試験のたびに他所へ問い合わせるのは失礼**ですし、
 * ダイヤが変われば答えも変わるので、試験が日によって落ちます。
 */
function stubFetch() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    // 中継は URL そのものを渡します（文字列でも Request でもありません）。
    const url = String(input?.url ?? input);
    calls.push(url);
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

async function ask(body) {
  const stub = stubFetch();
  try {
    const res = await worker.fetch(new Request(`${ORIGIN}/yahoo/transit`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), { ALLOW_ORIGIN: ORIGIN });
    return { res, doc: await res.json(), calls: stub.calls };
  } finally {
    stub.restore();
  }
}

const BASE = {
  from: "小田原", to: "東京",
  departAt: "2026-09-19T18:40:00+09:00",
};

test("頼まれなければ、これまでどおり出発時刻で聞く", async () => {
  const { doc, calls } = await ask(BASE);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /[?&]type=1(&|$)/);
  assert.equal(doc.search, "depart");
});

test("終電を頼まれたら、終電で聞く（type=2）", async () => {
  const { doc, calls } = await ask({ ...BASE, search: "last" });
  assert.match(calls[0], /[?&]type=2(&|$)/);
  assert.equal(doc.search, "last");
  assert.equal(doc.routed, true);
});

test("終電では、いちばん遅く出る便を採る", async () => {
  // 小田原→東京では 22:56 の新幹線が 23:29 に着き、いちばん早いです。
  // でも最後まで粘れるのは 22:58 のほうです。
  const { doc } = await ask({ ...BASE, search: "last" });
  assert.equal(doc.meta.departure, "22:58");
  assert.equal(doc.meta.arrival, "00:39");
  // ふつうの検索なら、いちばん早く着く便（新幹線）が採られます。
  const normal = await ask(BASE);
  assert.equal(normal.doc.meta.departure, "22:56");
  assert.equal(normal.doc.meta.arrival, "23:29");
});

test("終電の所要時間は、待ち時間を含まない", async () => {
  // ふつうの検索の minutes は「頼んだ時刻から着くまで」で、便を待つ
  // 時間を含みます。終電で 18:40 から数えると4時間を超え、
  // 「小田原→東京 4時間19分」という嘘になります。
  const { doc } = await ask({ ...BASE, search: "last" });
  assert.equal(doc.rideMinutes, 101);
  assert.equal(doc.minutes, 101);
  assert.equal(doc.waitMinutes, 0);
});

test("知らない search は、ふつうの検索として扱う", async () => {
  for (const bad of ["first", "", null, 1, { a: 1 }]) {
    const { calls, doc } = await ask({ ...BASE, search: bad });
    assert.match(calls[0], /[?&]type=1(&|$)/, `${JSON.stringify(bad)} が通っています`);
    assert.equal(doc.search, "depart");
  }
});

test("終電でも、乗り物の指定は効く", async () => {
  // 「電車で」と言った人に、終電として飛行機の最終便を返しません。
  const { calls } = await ask({ ...BASE, search: "last",
    modes: { al: 0, shin: 1, ex: 1, hb: 0, lb: 1, sr: 0 } });
  assert.match(calls[0], /[?&]al=0(&|$)/);
  assert.match(calls[0], /[?&]hb=0(&|$)/);
  assert.match(calls[0], /[?&]shin=1(&|$)/);
});

test("終電でも、ほかの候補は捨てない", async () => {
  // 22:58発が2本（00:39着と00:43着）と、22:56発の新幹線。
  // 採らなかったものも「ほかの行き方」として渡します。
  const { doc } = await ask({ ...BASE, search: "last" });
  assert.equal(doc.meta.alternatives.length, 2);
  assert.deepEqual(doc.meta.alternatives.map((a) => a.departure),
    ["22:58", "22:56"]);
});
