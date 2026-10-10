// 使われかたの件数（js/metrics.js と server/worker.js の /metrics）。
//
// 送るのは決まった出来事の名前と、決まった言葉の補足だけ。
// 外したとき・ブラウザが断っているとき・中継が無いときは送らない。

import assert from "node:assert/strict";
import test from "node:test";

import {
  METRICS_KEY, browserOptedOut, flushQueued, metricBody, metricsEnabled,
  queuedCount, setMetricsEnabled, track,
} from "../js/metrics.js";
import { METRIC_DETAILS, METRIC_EVENTS, metrics } from "../server/worker.js";
import { DETAILS, EVENTS } from "../js/metrics.js";

const PROXY = "https://proxy.example.workers.dev/";

/** 何も設定していない端末（既定は協力する）。 */
const optedIn = () => memStorage();

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
}

function fakeNav(extra = {}) {
  const sent = [];
  return {
    onLine: true,
    sendBeacon: (url, blob) => { sent.push({ url, blob }); return true; },
    sent,
    ...extra,
  };
}

test("送る中身は、決まった名前と決まった補足だけ", () => {
  assert.equal(metricBody("plan_ok", "car"), '{"e":"plan_ok","d":"car"}');
  // 知らない補足（入力した文など）は空にします。
  assert.equal(metricBody("plan_ok", "京都で紅葉"), '{"e":"plan_ok","d":""}');
  // 知らない出来事は送りません。
  assert.equal(metricBody("typed", "x"), null);
});

test("中継へ、text/plain で1件送る", async () => {
  const nav = fakeNav();
  assert.equal(track("spot_remove", "", { proxyUrl: PROXY, nav, storage: optedIn() }), true);
  assert.equal(nav.sent.length, 1);
  assert.equal(nav.sent[0].url, "https://proxy.example.workers.dev/metrics");
  assert.equal(nav.sent[0].blob.type, "text/plain");
  assert.equal(await nav.sent[0].blob.text(), '{"e":"spot_remove","d":""}');
});

test("送らないとき：外した・GPC・DNT・中継なし・http", () => {
  const off = memStorage({ [METRICS_KEY]: "off" });
  for (const [opts, why] of [
    [{ proxyUrl: PROXY, nav: fakeNav(), storage: off }, "設定で外した"],
    [{ proxyUrl: PROXY, nav: fakeNav({ globalPrivacyControl: true }), storage: optedIn() }, "GPC"],
    [{ proxyUrl: PROXY, nav: fakeNav({ doNotTrack: "1" }), storage: optedIn() }, "DNT"],
    [{ proxyUrl: "", nav: fakeNav(), storage: optedIn() }, "中継なし"],
    [{ proxyUrl: "http://proxy.example", nav: fakeNav(), storage: optedIn() }, "http"],
  ]) {
    assert.equal(track("plan_ok", "car", opts), false, why);
    assert.equal(opts.nav.sent.length, 0, why);
  }
});

test("設定は既定で「協力する」、「協力しない」にチェックを入れたときだけ止める", () => {
  const s = memStorage();
  assert.equal(metricsEnabled(s), true);
  const nav = fakeNav();
  assert.equal(track("plan_ok", "car", { proxyUrl: PROXY, nav, storage: s }), true);
  assert.equal(nav.sent.length, 1);
  // チェックを入れた（止める）。
  setMetricsEnabled(false, s);
  assert.equal(s.getItem(METRICS_KEY), "off");
  assert.equal(metricsEnabled(s), false);
  assert.equal(track("plan_ok", "car", { proxyUrl: PROXY, nav, storage: s }), false);
  assert.equal(nav.sent.length, 1);
  // 外した（また数える）。
  setMetricsEnabled(true, s);
  assert.equal(metricsEnabled(s), true);
  // 保存できない環境でも止まりません。
  const broken = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); } };
  assert.equal(metricsEnabled(broken), true);
  setMetricsEnabled(false, broken);
  assert.equal(browserOptedOut({}), false);
});

test("前の版で保存した値の意味が、そのまま続く", () => {
  // 前の版で「協力する」を入れた人（"on"）は、数え続ける。
  assert.equal(metricsEnabled(memStorage({ [METRICS_KEY]: "on" })), true);
  // 止めた人（"off"）は、止まったまま。
  assert.equal(metricsEnabled(memStorage({ [METRICS_KEY]: "off" })), false);
});

test("圏外のあいだは貯めて、つながったら送る", () => {
  const nav = fakeNav({ onLine: false });
  const opts = { proxyUrl: PROXY, nav, storage: optedIn() };
  assert.equal(track("plan_error", "offline", opts), false);
  assert.equal(track("offline_seen", "", opts), false);
  assert.equal(queuedCount(), 2);
  assert.equal(nav.sent.length, 0);
  nav.onLine = true;
  assert.equal(flushQueued(opts), 2);
  assert.equal(queuedCount(), 0);
  assert.equal(nav.sent.length, 2);
});

test("画面と中継で、数える名前がそろっている", () => {
  assert.deepEqual([...EVENTS].sort(), [...METRIC_EVENTS].sort());
  assert.deepEqual([...DETAILS].sort(), [...METRIC_DETAILS].sort());
});

function post(body) {
  return new Request("https://proxy.example/metrics", {
    method: "POST", headers: { "content-type": "text/plain" }, body,
  });
}

test("中継は、決まった出来事だけを書く", async () => {
  const points = [];
  const env = { METRICS: { writeDataPoint: (p) => points.push(p) } };
  let res = await metrics(post('{"e":"plan_ok","d":"walk"}'), env);
  assert.equal(res.status, 204);
  res = await metrics(post('{"e":"plan_ok","d":"東京駅"}'), env);
  assert.equal(res.status, 204);
  assert.deepEqual(points, [
    { indexes: ["plan_ok"], blobs: ["plan_ok", "walk"], doubles: [1] },
    { indexes: ["plan_ok"], blobs: ["plan_ok", ""], doubles: [1] },
  ]);
  assert.equal((await metrics(post('{"e":"whoami"}'), env)).status, 400);
  assert.equal((await metrics(post("not json"), env)).status, 400);
  assert.equal(points.length, 2);
});

test("書き先が無い・壊れていても、204 で返す", async () => {
  assert.equal((await metrics(post('{"e":"plan_ok"}'), {})).status, 204);
  const env = { METRICS: { writeDataPoint() { throw new Error("down"); } } };
  const orig = console.error; console.error = () => {};
  try {
    assert.equal((await metrics(post('{"e":"plan_ok"}'), env)).status, 204);
  } finally { console.error = orig; }
});
