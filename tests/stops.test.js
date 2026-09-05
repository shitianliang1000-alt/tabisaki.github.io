// 停留所（駅・バス停）の最寄り検索。
//
// 実データは fetch で kb/stops-*.json を取りに行くので、テストでは
// fetch を差し替えて、狭い範囲の停留所だけを返します。

import assert from "node:assert/strict";
import test from "node:test";

import { findStop, nearestStop, resetStopsCache, searchStops }
  from "../js/stops.js";

const FUJI_5GO = { lat: 35.3606, lng: 138.7364 };
const FUJI_SUMMIT = { lat: 35.3606, lng: 138.7305 };
const TOKYO = { lat: 35.6812, lng: 139.7671 };

function withStops(rail, bus, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = String(url).includes("stops-bus") ? bus : rail;
    return { ok: true, json: async () => body };
  };
  return fn().finally(() => {
    globalThis.fetch = real;
    resetStopsCache();
  });
}

test("近くの停留所を、駅・バス停どちらからでも見つけられる", () =>
  withStops(
    { year: 2008, stops: [] },
    { year: 2012, stops: [[35.3600, 138.7370, "富士山五合目"]] },
    async () => {
      const s = await nearestStop(FUJI_5GO, 3);
      assert.equal(s?.name, "富士山五合目");
    }));

test("範囲より遠ければ、見つからない扱いにする", () =>
  withStops(
    { year: 2008, stops: [] },
    { year: 2012, stops: [[35.3600, 138.7370, "富士山五合目"]] },
    async () => {
      const s = await nearestStop(TOKYO, 3);
      assert.equal(s, null);
    }));

test("複数あれば、いちばん近いものを返す", () =>
  withStops(
    { year: 2008, stops: [[35.3606, 138.7305, "山頂駅（仮）"]] },
    { year: 2012, stops: [[35.3600, 138.7370, "富士山五合目"]] },
    async () => {
      const s = await nearestStop(FUJI_SUMMIT, 5);
      assert.equal(s?.name, "山頂駅（仮）");
    }));

test("読み込みに失敗しても、例外を投げずに「無い」を返す", () =>
  withStops(null, null, async () => {
    globalThis.fetch = async () => { throw new Error("network"); };
    const s = await nearestStop(TOKYO, 3);
    assert.equal(s, null);
  }));

// --- 出発地・到着地の入力補完 ----------------------------------------------
//
// 主要駅78件しか出発地に選べないと、最寄りが載っていない人は使い始める
// ことすらできません。全国の停留所から名前で引けるようにします。

const NAMED = {
  rail: { year: 2008, stops: [
    [35.6896, 139.7006, "新宿"],
    [35.6812, 139.7671, "東京"],
    [34.7025, 135.4959, "大阪"],
  ] },
  bus: { year: 2012, stops: [
    [35.6900, 139.7000, "新宿駅西口"],
    [35.3600, 138.7370, "富士山五合目"],
  ] },
};

test("名前から停留所を引ける（「駅」の有無は問わない）", () =>
  withStops(NAMED.rail, NAMED.bus, async () => {
    assert.equal((await findStop("新宿"))?.name, "新宿");
    assert.equal((await findStop("新宿駅"))?.name, "新宿");
    assert.equal((await findStop(" 東京 "))?.name, "東京");
    assert.equal(await findStop("存在しない停留所"), null);
    assert.equal(await findStop(""), null);
  }));

test("打った文字で候補を絞る。前方一致を先に返す", () =>
  withStops(NAMED.rail, NAMED.bus, async () => {
    const found = await searchStops("新宿", 20);
    assert.equal(found[0].name, "新宿", "前方一致が先頭に来ていません");
    assert.ok(found.some((s) => s.name === "新宿駅西口"));
    assert.ok(!found.some((s) => s.name === "大阪"));
  }));

test("候補は数を絞る（7万件を一度に並べない）", () =>
  withStops(NAMED.rail, NAMED.bus, async () => {
    assert.ok((await searchStops("新", 2)).length <= 2);
    assert.deepEqual(await searchStops("", 20), []);
  }));

test("同じ名前なら、バス停より駅を先に採る", () =>
  withStops(
    { year: 2008, stops: [[35.68, 139.76, "本町"]] },
    { year: 2012, stops: [[34.68, 135.50, "本町"]] },
    async () => {
      assert.equal((await findStop("本町"))?.kind, "rail");
    }));
