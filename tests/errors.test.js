// 技術的なエラーを、旅行者の言葉に翻訳するテスト。
//
// 「Routes API: HTTP 403 API key restriction」は、開発者には有益ですが
// 旅行者には何のことか分かりません。知りたいのは
// 「それで、旅程は作れるのか」の一点です。
//
// なので二層に分けます。
//   表  … 何が起きて、旅程はどうなるのか（旅行者向け）
//   裏  … 元のエラーそのまま（開いた人だけ見る）

import assert from "node:assert/strict";
import test from "node:test";

import { userFacing } from "../js/errors.js";

test("経路が取れないときは、旅程が作れることを先に言う", () => {
  const m = userFacing("routes", "Routes API 403: API_KEY_HTTP_REFERRER_BLOCKED");
  assert.match(m.title, /交通|経路/);
  assert.match(m.body, /旅程/);
  assert.ok(!/403|API_KEY|HTTP/.test(m.title + m.body),
    `旅行者向けの文に技術用語が残っています: ${m.title} / ${m.body}`);
  assert.match(m.detail, /403/);
  assert.equal(m.blocking, false);
});

test("AIが使えないときも、旅程は作れると言う", () => {
  const m = userFacing("ai", "401 Unauthorized");
  assert.match(m.body, /旅程|収録/);
  assert.ok(!/401|Unauthorized/.test(m.title + m.body));
  assert.equal(m.blocking, false);
});

test("キーが未設定のときは、責める言い方をしない", () => {
  const m = userFacing("routes", "APIキー未設定");
  assert.ok(!/エラー|失敗/.test(m.title), `${m.title}`);
  assert.match(m.body, /推定/);
});

test("使いすぎで止めたときは、止めたのが自分だと分かるように書く", () => {
  const m = userFacing("quota", "APIの使用量の確認で「やめる」を選ばれたため…");
  assert.match(m.title, /使用量|止め/);
  assert.match(m.body, /やめる|止め/);
});

test("天気が取れないのは、旅程に関係ないと言う", () => {
  const m = userFacing("weather", "天気を取得できませんでした（通信）。");
  assert.match(m.body, /旅程/);
  assert.equal(m.blocking, false);
});

test("知識ベースが読めないのは、先に進めない（そう言う）", () => {
  const m = userFacing("kb", "Failed to fetch kb/index.json");
  assert.equal(m.blocking, true);
  assert.match(m.body, /読み込め/);
});

test("知らない種類でも、何か返す（画面が空にならない）", () => {
  const m = userFacing("なにか", "よく分からない失敗");
  assert.ok(m.title && m.body);
  assert.equal(m.detail, "よく分からない失敗");
});

test("元のエラーが無くても落ちない", () => {
  for (const bad of [null, undefined, "", new Error("x")]) {
    const m = userFacing("routes", bad);
    assert.ok(m.title);
  }
});

test("同じ種類・同じ原因なら、同じ文になる", () => {
  const a = userFacing("routes", "Routes API 403: blocked");
  const b = userFacing("routes", "Routes API 403: blocked");
  assert.deepEqual(a, b);
});

// --- 「次に何をすればいいか」まで書く ---------------------------------------
// 何が起きたかだけを伝えても、読んだ人は止まります。多くの場合、
// 答えは「そのまま旅程は作れます」です。それを書かないと、直さないと
// 先へ進めないもののように見えます。

test("どの種類にも、次にできることが書いてある", () => {
  for (const kind of ["routes", "ai", "weather", "photo", "quota", "kb"]) {
    const m = userFacing(kind, "HTTP 500");
    assert.ok(m.next && m.next.length > 5, `${kind} に next がありません`);
  }
});

test("止まらない失敗には「そのまま作れます」と言う", () => {
  for (const kind of ["routes", "ai", "weather", "photo"]) {
    const m = userFacing(kind, "HTTP 500");
    assert.equal(m.blocking, false);
    assert.match(m.next, /そのまま/, `${kind}: ${m.next}`);
  }
});

test("本当に止まるものには、直しかたを書く", () => {
  const m = userFacing("kb", "fetch failed");
  assert.equal(m.blocking, true);
  assert.match(m.next, /http\.server|localhost/);
  assert.doesNotMatch(m.next, /そのまま/,
    "作れないのに「そのまま作れます」と書いています");
});

test("未設定のときも、次にできることを言う", () => {
  const m = userFacing("ai", "GEMINI_API_KEY が未設定です");
  assert.match(m.title, /設定になっています/);
  assert.match(m.next, /そのまま/);
  assert.match(m.next, /GEMINI_API_KEY/, "設定したい人向けの道も要ります");
});

test("知らない種類でも、行き止まりにしない", () => {
  const m = userFacing("なにか", "???");
  assert.ok(m.next, "控えの文にも next がありません");
});
