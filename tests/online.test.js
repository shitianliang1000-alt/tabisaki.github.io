// 圏外の帯。
//
// 出すのは「確実につながっていない」ときだけ。戻ったら少しだけ
// 「つながりました」を出して消える。最初からつながっているなら何も出さない。

import assert from "node:assert/strict";
import test from "node:test";

import {
  BACK_ONLINE_TEXT, OFFLINE_TEXT, isOffline, watchConnection,
} from "../js/online.js";

/** classList と hidden だけを持つ、最小の帯。 */
function fakeBar() {
  const classes = new Set();
  const body = new Set();
  return {
    textContent: "", hidden: true,
    classList: {
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    ownerDocument: { body: { classList: {
      toggle: (c, on) => (on ? body.add(c) : body.delete(c)),
    } } },
    bodyHas: (c) => body.has(c),
  };
}

function env(onLine) {
  const win = new EventTarget();
  const timers = [];
  return {
    nav: { onLine },
    win,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    timers,
  };
}

test("つながっているときは、何も出さない", () => {
  const bar = fakeBar();
  watchConnection(bar, env(true));
  assert.equal(bar.hidden, true);
  assert.equal(bar.textContent, "");
});

test("圏外なら、何ができるかまで書いて出す", () => {
  const bar = fakeBar();
  watchConnection(bar, env(false));
  assert.equal(bar.hidden, false);
  assert.equal(bar.textContent, OFFLINE_TEXT);
  assert.match(OFFLINE_TEXT, /保存した旅程は開けます/);
  assert.match(OFFLINE_TEXT, /目安/);
  assert.ok(bar.bodyHas("offline"));
});

test("圏外から戻ったら、少しだけ知らせて消える", () => {
  const bar = fakeBar();
  const e = env(false);
  watchConnection(bar, e);
  e.nav.onLine = true;
  e.win.dispatchEvent(new Event("online"));
  assert.equal(bar.textContent, BACK_ONLINE_TEXT);
  assert.equal(bar.hidden, false);
  assert.ok(!bar.bodyHas("offline"));
  e.timers.at(-1)();
  assert.equal(bar.hidden, true);
});

test("途中で圏外になっても出る。やめたら見張らない", () => {
  const bar = fakeBar();
  const e = env(true);
  const stop = watchConnection(bar, e);
  e.nav.onLine = false;
  e.win.dispatchEvent(new Event("offline"));
  assert.equal(bar.textContent, OFFLINE_TEXT);
  stop();
  e.nav.onLine = true;
  e.win.dispatchEvent(new Event("online"));
  assert.equal(bar.textContent, OFFLINE_TEXT);
});

test("onLine が分からない環境は、つながっているとみなす", () => {
  assert.equal(isOffline({}), false);
  assert.equal(isOffline(undefined), false);
  assert.equal(isOffline({ onLine: false }), true);
});
