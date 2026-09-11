// 中継の「重さ」と「断りかた」。
//
// 無料枠は、使い切ると追加課金ではなく**その種類の処理が失敗**します。
// つまり、止まるときは全員に対して止まります。だから中継の仕事は2つ。
//
//   1. 重いものを叩かれすぎないように、重さに応じて数える
//   2. 断るときは、受け取る側が次の手を決められる形で断る

import assert from "node:assert/strict";
import test from "node:test";

import worker, { RateLimiter, costOf } from "../server/worker.js";
import { readProxyError } from "../js/endpoints.js";

const ORIGIN = "https://shitianliang1000-alt.github.io";

// --- 1. 重さ ----------------------------------------------------------------

test("処理の重さに応じて点を数える", () => {
  // /status はこちらで完結します。数える必要がありません。
  assert.equal(costOf("/status"), 0);
  // 無料でも取りに行くもの < 課金されるもの < 枠を分け合うもの
  assert.ok(costOf("/yahoo/transit") < costOf("/routes"));
  assert.ok(costOf("/routes") <= costOf("/gemini/generate"));
  assert.equal(costOf("/cf/generate"), costOf("/gemini/generate"));
  // 知らない入口は、ひとまず1点として数えます（0にはしません）。
  assert.equal(costOf("/なにか"), 1);
});

/** Durable Object の代わり。storage だけ持てば足ります。 */
function fakeState() {
  const map = new Map();
  return {
    storage: {
      get: async (k) => map.get(k),
      put: async (k, v) => void map.set(k, v),
      deleteAll: async () => map.clear(),
      setAlarm: async () => {},
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
}

test("重い処理は、軽い処理より早く上限に当たる", async () => {
  const heavy = new RateLimiter(fakeState());
  let ok = 0;
  // 5点の処理は、1分20点なら4回で使い切ります。
  for (let i = 0; i < 6; i++) {
    const r = await (await heavy.fetch(
      new Request("https://rate/check?cost=5"))).json();
    if (r.ok) ok++;
  }
  assert.equal(ok, 4, "5点の処理が4回を超えて通っています");

  const light = new RateLimiter(fakeState());
  let okLight = 0;
  for (let i = 0; i < 6; i++) {
    const r = await (await light.fetch(
      new Request("https://rate/check?cost=1"))).json();
    if (r.ok) okLight++;
  }
  assert.equal(okLight, 6, "1点の処理まで早く止めています");
});

test("0点の処理は、いくら呼んでも枠を減らさない", async () => {
  const rl = new RateLimiter(fakeState());
  for (let i = 0; i < 50; i++) {
    const r = await (await rl.fetch(
      new Request("https://rate/check?cost=0"))).json();
    assert.equal(r.ok, true);
  }
  const usage = await (await rl.fetch(
    new Request("https://rate/usage"))).json();
  assert.equal(usage.usage.minute, 0);
});

test("いま何点使っているかを、減らさずに見られる", async () => {
  const rl = new RateLimiter(fakeState());
  await rl.fetch(new Request("https://rate/check?cost=3"));
  const a = await (await rl.fetch(new Request("https://rate/usage"))).json();
  const b = await (await rl.fetch(new Request("https://rate/usage"))).json();
  assert.equal(a.usage.minute, 3);
  assert.equal(b.usage.minute, 3, "見ただけで減っています");
  assert.equal(a.usage.minuteLimit > 0, true);
});

// --- 2. 断りかた ------------------------------------------------------------

test("断るときは、次の手を決められる形で返す", async () => {
  const res = await worker.fetch(
    new Request("https://x/なにもない入口", { method: "POST", body: "{}" }),
    { ALLOW_ORIGIN: ORIGIN });
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(typeof body.error.code, "string");
  assert.equal(typeof body.error.retryable, "boolean");
  // 前からある形（error.message）は壊しません。
  assert.equal(typeof body.error.message, "string");
});

test("受け取る側は、やり直せるかどうかを番号から推し量らない", () => {
  const limit = readProxyError(
    '{"ok":false,"error":{"code":"UPSTREAM_LIMIT","service":"routes",'
    + '"retryable":true,"message":"いま利用が集中しています。"}}', 429);
  assert.equal(limit.code, "UPSTREAM_LIMIT");
  assert.equal(limit.retryable, true);
  assert.equal(limit.service, "routes");

  // 形の違う返事（古い中継・素の500）でも、読めるところまでは読みます。
  const broken = readProxyError("<html>502 Bad Gateway</html>", 502);
  assert.equal(broken.retryable, true);
  assert.match(broken.message, /時間をおいて/);

  // やり直しても同じもの（キー未設定）は、retryable を立てません。
  const noKey = readProxyError(
    '{"ok":false,"error":{"code":"NOT_CONFIGURED","retryable":false,'
    + '"message":"中継にキーがありません"}}', 503);
  assert.equal(noKey.retryable, false);
});
