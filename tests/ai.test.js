// AIに投げるリクエストの形。
//
// キーが無くても、送る前の形は確かめられます。モデルによって受け付ける
// 項目が違うので、ここを取り違えると 400 が返り、候補を1つずつ落として
// 最後は「AIに聞けませんでした」になります。

import assert from "node:assert/strict";
import test from "node:test";

// --- Gemma に投げる形 -------------------------------------------------------
//
// Gemma には構造化出力（responseSchema）がありません。付けて投げると
// 400 が返り、モデルの候補を1つ落として次へ行ってしまいます。
// 本文で「JSONだけ」と頼み、返事から拾います。

test("Gemma には responseSchema を付けない", async () => {
  const { buildModelRequest } = await import("../js/ai.js");
  const schema = { type: "OBJECT", properties: {} };
  const r = buildModelRequest("旅程を作って", { schema, model: "gemma-4-e2b-it" });
  assert.ok(!("responseSchema" in r.generationConfig),
    "Gemma に構造化出力を送っています");
  assert.ok(!("responseMimeType" in r.generationConfig));
  assert.match(r.contents[0].parts[0].text, /JSON だけ/);
});

test("Gemini には、これまでどおり構造化出力を送る", async () => {
  const { buildModelRequest } = await import("../js/ai.js");
  const schema = { type: "OBJECT", properties: {} };
  const r = buildModelRequest("旅程を作って", { schema, model: "gemini-3.7-flash" });
  assert.equal(r.generationConfig.responseSchema, schema);
  assert.equal(r.generationConfig.responseMimeType, "application/json");
  assert.ok(!/JSON だけ/.test(r.contents[0].parts[0].text));
});

test("中継は、使うモデルを通す", async () => {
  const { readFile } = await import("node:fs/promises");
  const worker = await readFile(new URL("../server/worker.js", import.meta.url),
                                "utf8");
  const { MODEL, FALLBACK_MODELS, CF_MODEL, CF_FALLBACK_MODELS }
    = await import("../js/config.js");
  for (const m of [MODEL, ...FALLBACK_MODELS, CF_MODEL, ...CF_FALLBACK_MODELS]) {
    assert.ok(worker.includes(`"${m}"`),
      `中継の ALLOWED_MODELS に ${m} がありません（400 で弾かれます）`);
  }
});

test("Workers AI の返事は、入れ物が違っても取り出す", async () => {
  const { cfText } = await import("../server/worker.js");
  // 入れ物はモデルによって違います。1つだけを見ていたので、Gemma 4 が
  // 空で返ってきていました（中継は動いているのに、答えが出ない）。
  assert.equal(cfText({ response: "答え" }), "答え");
  assert.equal(cfText({ result: { response: "答え" } }), "答え");
  assert.equal(cfText({ choices: [{ message: { content: "答え" } }] }), "答え");
  assert.equal(cfText({ output: [{ content: [{ text: "答" }, { text: "え" }] }] }),
               "答え");
  assert.equal(cfText("答え"), "答え");
  // どれにも当たらなければ空。呼び出し側が「形」を返して次の手を決めます。
  assert.equal(cfText({ usage: { tokens: 1 } }), "");
});

test("Cloudflare で動かすときは、Gemini の埋め込みを呼ばない", async () => {
  const { embedQuery, usingCloudflare } = await import("../js/ai.js");
  const real = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; throw new Error("呼ばれました"); };
  try {
    const v = await embedQuery("温泉でゆっくり");
    if (usingCloudflare()) {
      // AI本体は Workers AI なのに、検索用のベクトルだけ Gemini を
      // 呼んでいました。中継に鍵が無ければ503で、握りつぶして語句検索に
      // 落ちます——旅程を作るたびに、無駄な往復と待ち時間が出ます。
      assert.equal(called, 0, "Gemini の埋め込みを呼んでいます");
      assert.equal(v, null);
    }
  } finally {
    globalThis.fetch = real;
  }
});
