// 停留所（駅・バス停）の最寄り検索。
//
// 実データは fetch で kb/stops-*.json を取りに行くので、テストでは
// fetch を差し替えて、狭い範囲の停留所だけを返します。

import assert from "node:assert/strict";
import test from "node:test";

import { nearestStop, resetStopsCache } from "../js/stops.js";

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
