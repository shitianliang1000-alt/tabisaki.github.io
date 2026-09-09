// カードに実際の写真を載せるテスト。
//
// 収録データに写真はありませんが、多くのスポットは Wikipedia の記事名を
// 持っています。そこから代表画像だけを取ります。無ければ art.js の絵の
// ままです。**取れないことは失敗ではありません。**
//
// 気をつけたのは3つ。
//   ・同じ場所を何度も取りに行かない（保存して使い回す）
//   ・取れなかったことも覚える（毎回問い合わせない）
//   ・失敗しても画面は必ず出る（写真は飾りで、旅程の本体ではない）

import assert from "node:assert/strict";
import test from "node:test";

import { clearPhotoCache, photoFor, photoUrlsFrom } from "../js/photos.js";

function store() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v),
           removeItem: (k) => m.delete(k), _m: m };
}

const okBody = {
  thumbnail: { source: "https://example.test/matsuyama.jpg", width: 320 },
  originalimage: { source: "https://example.test/matsuyama-big.jpg" },
};

function fakeFetch(body, status = 200) {
  const calls = [];
  return {
    calls,
    fn: async (url) => {
      calls.push(url);
      return { ok: status < 400, status, json: async () => body };
    },
  };
}

test("Wikipedia の記事名から、写真のURLを取る", async () => {
  const f = fakeFetch(okBody);
  const url = await photoFor({ id: "s1", name: "松山城", wikipedia: "松山城" },
                             { fetchImpl: f.fn, storage: store() });
  assert.equal(url, "https://example.test/matsuyama.jpg");
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /ja\.wikipedia\.org/);
  assert.match(f.calls[0], /%E6%9D%BE%E5%B1%B1%E5%9F%8E/);
});

test("同じ場所は二度取りに行かない", async () => {
  const f = fakeFetch(okBody);
  const st = store();
  const opts = { fetchImpl: f.fn, storage: st };
  const a = { id: "s1", name: "松山城", wikipedia: "松山城" };
  await photoFor(a, opts);
  await photoFor(a, opts);
  await photoFor(a, opts);
  assert.equal(f.calls.length, 1, `${f.calls.length}回 取りに行っています`);
});

test("写真が無い記事は「無い」と覚えて、二度と聞かない", async () => {
  const f = fakeFetch({ type: "standard" });   // thumbnail が無い
  const st = store();
  const opts = { fetchImpl: f.fn, storage: st };
  const a = { id: "s2", name: "無名の丘", wikipedia: "無名の丘" };
  assert.equal(await photoFor(a, opts), null);
  assert.equal(await photoFor(a, opts), null);
  assert.equal(f.calls.length, 1, "無いと分かった後も聞きに行っています");
});

test("通信が失敗しても、null を返すだけ（例外を投げない）", async () => {
  const boom = async () => { throw new Error("ネットワークが死んでいます"); };
  const url = await photoFor({ id: "s3", name: "どこか", wikipedia: "どこか" },
                             { fetchImpl: boom, storage: store() });
  assert.equal(url, null);
});

test("404 でも、null を返すだけ", async () => {
  const f = fakeFetch({}, 404);
  const url = await photoFor({ id: "s4", name: "無い記事", wikipedia: "無い記事" },
                             { fetchImpl: f.fn, storage: store() });
  assert.equal(url, null);
});

test("記事名が無い場所には、そもそも聞きに行かない", async () => {
  const f = fakeFetch(okBody);
  const url = await photoFor({ id: "s5", name: "" },
                             { fetchImpl: f.fn, storage: store() });
  assert.equal(url, null);
  assert.equal(f.calls.length, 0);
});

test("旅程ぶんをまとめて取れる（順番は保つ）", async () => {
  const f = fakeFetch(okBody);
  const spots = [
    { id: "a", name: "A", wikipedia: "A" },
    { id: "b", name: "B" },                   // 記事名なし
    { id: "c", name: "C", wikipedia: "C" },
  ];
  const map = await photoUrlsFrom(spots, { fetchImpl: f.fn, storage: store() });
  assert.equal(map.get("a"), "https://example.test/matsuyama.jpg");
  assert.equal(map.has("b"), false);
  assert.equal(map.get("c"), "https://example.test/matsuyama.jpg");
  assert.equal(f.calls.length, 2);
});

test("保存を消せる（写真が古くなったとき用）", async () => {
  const f = fakeFetch(okBody);
  const st = store();
  const opts = { fetchImpl: f.fn, storage: st };
  const a = { id: "s1", name: "松山城", wikipedia: "松山城" };
  await photoFor(a, opts);
  clearPhotoCache(st);
  await photoFor(a, opts);
  assert.equal(f.calls.length, 2);
});
