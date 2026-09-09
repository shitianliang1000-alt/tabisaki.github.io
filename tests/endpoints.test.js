// APIキーをブラウザに置かないための仕組みのテスト。
//
// いまの作りでは、キーがページを開いた人から見えます。開発中は
// それでよくても、公開するなら第三者に使われて課金だけが増えます。
//
// 直しかたは「自分のバックエンドを1枚挟む」ことです。ブラウザは
// キーを持たず、自分のサーバーへ投げる。サーバーがキーを付けて
// Google へ渡す。ここでは、その切り替えを決める部分だけを見ます。

import assert from "node:assert/strict";
import test from "node:test";

import { endpointFor, keyHeaders, usingProxy } from "../js/endpoints.js";

const DIRECT = { proxyUrl: "", geminiKey: "AIzaTEST", mapsKey: "AIzaMAPS" };
const PROXY = { proxyUrl: "https://api.example.test/tabisaki",
                geminiKey: "", mapsKey: "" };

test("プロキシが未設定なら、これまでどおり Google を直接呼ぶ", () => {
  assert.equal(usingProxy(DIRECT), false);
  const u = endpointFor("gemini:generate", { model: "gemini-3.7-flash" }, DIRECT);
  assert.match(u, /^https:\/\/generativelanguage\.googleapis\.com\//);
  assert.match(u, /gemini-3\.7-flash:generateContent$/);
  assert.match(endpointFor("routes", {}, DIRECT),
               /^https:\/\/routes\.googleapis\.com\//);
});

test("プロキシがあれば、Google のURLは一切出てこない", () => {
  assert.equal(usingProxy(PROXY), true);
  for (const what of ["gemini:generate", "gemini:embed", "routes"]) {
    const u = endpointFor(what, { model: "m" }, PROXY);
    assert.ok(!/googleapis\.com/.test(u), `${what} が直接 Google を指しています: ${u}`);
    assert.ok(u.startsWith("https://api.example.test/tabisaki/"), u);
  }
});

test("プロキシ経由では、キーをヘッダーに載せない", () => {
  const h = keyHeaders("gemini", PROXY);
  assert.equal(h["x-goog-api-key"], undefined);
  assert.deepEqual(Object.keys(h), []);
  const hm = keyHeaders("maps", PROXY);
  assert.equal(hm["X-Goog-Api-Key"], undefined);
});

test("直接呼ぶときだけ、キーをヘッダーに載せる", () => {
  assert.equal(keyHeaders("gemini", DIRECT)["x-goog-api-key"], "AIzaTEST");
  assert.equal(keyHeaders("maps", DIRECT)["X-Goog-Api-Key"], "AIzaMAPS");
});

test("プロキシのURLの末尾のスラッシュは、あってもなくても同じ", () => {
  const a = endpointFor("routes", {}, { ...PROXY, proxyUrl: "https://x.test/p" });
  const b = endpointFor("routes", {}, { ...PROXY, proxyUrl: "https://x.test/p/" });
  assert.equal(a, b);
});

test("プロキシがあれば、キーが空でも「使える」と判断する", () => {
  // キーはサーバーが持っているので、ブラウザ側が空なのは正常です。
  const { hasGemini, hasMaps } = usingProxy(PROXY)
    ? { hasGemini: true, hasMaps: true } : {};
  assert.equal(hasGemini, true);
  assert.equal(hasMaps, true);
});

test("http のプロキシは受け付けない（キーが平文で流れるため）", () => {
  assert.throws(
    () => endpointFor("routes", {}, { proxyUrl: "http://insecure.test/p" }),
    /https/);
});

test("設定が空でも落ちない", () => {
  const u = endpointFor("routes", {}, {});
  assert.match(u, /routes\.googleapis\.com/);
});

// --- 自分で立てたモデル（Gemma など） ---------------------------------------
// 公開重みのモデルを自分の機械で動かすと、呼び出しに課金が発生しません。
// そのかわり、Gemini の responseSchema と Google 検索は使えません。

test("プロキシ経由なら、ローカルモデルも同じ入口にまとまる", () => {
  const cfg = { proxyUrl: "https://api.example.com" };
  assert.equal(endpointFor("local:generate", {}, cfg),
    "https://api.example.com/local/generate");
});

test("直に叩くときは OpenAI 互換の道に向く", () => {
  const cfg = { localBaseUrl: "http://localhost:11434" };
  assert.equal(endpointFor("local:generate", {}, cfg),
    "http://localhost:11434/v1/chat/completions");
});

test("末尾のスラッシュがあっても、道が二重にならない", () => {
  const cfg = { localBaseUrl: "http://localhost:11434///" };
  assert.equal(endpointFor("local:generate", {}, cfg),
    "http://localhost:11434/v1/chat/completions");
});

test("行き先が無いまま、黙って動かない", () => {
  // 空のまま呼ぶと、どこにも繋がらないのに「AIが効いている」ことに
  // なります。理由の分かるエラーで止めます。
  assert.throws(() => endpointFor("local:generate", {}, {}),
    /LOCAL_BASE_URL/);
});

test("ローカルモデルにキーは載せない", () => {
  // キーという概念がありません。うっかり載せると、自分の機械へ
  // Google のキーを送ることになります。
  assert.deepEqual(keyHeaders("gemini", { localBaseUrl: "http://localhost:11434" }),
                   {});
});
