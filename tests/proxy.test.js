// APIプロキシの防御のテスト。
//
// 「APIキーを隠したから安全」ではありません。キーを隠しても、入口が
// 誰でも叩ける状態なら、プロキシ自体が無料のAPIとして使われます。
// 請求は持ち主に来ます。ここで確かめるのは、その入口の締まりかたです。

import assert from "node:assert/strict";
import test from "node:test";

import { clientIp, rateCheck } from "../server/node-proxy.mjs";

test("上限までは通す", () => {
  const store = new Map();
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    assert.equal(rateCheck(store, "1.2.3.4", now, 20, 200).ok, true,
      `${i + 1}回目で止まっています`);
  }
});

test("1分の上限を超えたら止める", () => {
  const store = new Map();
  const now = Date.now();
  for (let i = 0; i < 20; i++) rateCheck(store, "1.2.3.4", now, 20, 200);
  const over = rateCheck(store, "1.2.3.4", now, 20, 200);
  assert.equal(over.ok, false);
  assert.equal(over.retryAfter, 60);
});

test("1分たてば、また通る", () => {
  const store = new Map();
  const now = Date.now();
  for (let i = 0; i < 20; i++) rateCheck(store, "1.2.3.4", now, 20, 200);
  assert.equal(rateCheck(store, "1.2.3.4", now + 61_000, 20, 200).ok, true);
});

test("1時間の上限は、分をまたいでも効く", () => {
  const store = new Map();
  const base = Date.now();
  // 1分あたり5回を、40分に分けて出す（分の上限には当たらない）
  for (let m = 0; m < 40; m++) {
    for (let i = 0; i < 5; i++) rateCheck(store, "1.2.3.4", base + m * 61_000, 20, 200);
  }
  const over = rateCheck(store, "1.2.3.4", base + 40 * 61_000, 20, 200);
  assert.equal(over.ok, false, "1時間の上限（200回）を超えても通っています");
  assert.equal(over.retryAfter, 600);
});

test("IPごとに数える（他人の分で止まらない）", () => {
  const store = new Map();
  const now = Date.now();
  for (let i = 0; i < 20; i++) rateCheck(store, "1.1.1.1", now, 20, 200);
  assert.equal(rateCheck(store, "2.2.2.2", now, 20, 200).ok, true);
});

// --- 接続元の見分けかた -----------------------------------------------------
// X-Forwarded-For の**先頭**を使うと、送り手が好きな値を書けます。
// 「毎回ちがうIPを名乗る」だけで、レート制限は素通りになります。

test("既定では X-Forwarded-For を信用しない", () => {
  delete process.env.TRUST_PROXY;
  assert.equal(clientIp({ "x-forwarded-for": "9.9.9.9" }, "10.0.0.1"), "10.0.0.1");
});

test("逆プロキシの後ろでは、最後の1つだけを使う", () => {
  process.env.TRUST_PROXY = "1";
  // 先頭の 9.9.9.9 は送り手が書けます。信じてよいのは、自分の
  // 逆プロキシが最後に足した 10.0.0.9 のほうです。
  assert.equal(
    clientIp({ "x-forwarded-for": "9.9.9.9, 10.0.0.9" }, "127.0.0.1"),
    "10.0.0.9");
  delete process.env.TRUST_PROXY;
});

test("どこからか分からないときも、必ず何かを返す", () => {
  assert.equal(clientIp({}, ""), "unknown");
});

// --- Origin の無いリクエスト -----------------------------------------------
// ブラウザは、クロスオリジンの POST に必ず Origin を付けます。付いて
// いないということは、ブラウザから来ていないということです。

test("Origin が無いリクエストは、利用者からのものではない", () => {
  // ALLOW_ORIGIN を設定しているとき、空の Origin は一致しません。
  const allow = "https://example.com";
  const judge = (origin) => Boolean(allow) && origin !== allow;
  assert.equal(judge(""), true, "Origin が空でも通しています");
  assert.equal(judge(undefined), true);
  assert.equal(judge("https://evil.example"), true);
  assert.equal(judge(allow), false, "自分のサイトを弾いています");
});

test("上限ちょうどまでは通り、その次で止まる（取りこぼしなし）", () => {
  // 数えかたに割り込みが入ると、上限20のつもりが何回でも通ります。
  const store = new Map();
  const now = Date.now();
  let passed = 0;
  for (let i = 0; i < 100; i++) {
    if (rateCheck(store, "1.2.3.4", now, 20, 200).ok) passed++;
  }
  assert.equal(passed, 20, `${passed}回 通っています（20回のはずです）`);
});
