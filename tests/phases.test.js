// 生成中の3つの区切り（js/ui.js の PHASES）。
// 6つの段がもれなく、順に、どれか1つの区切りに入っていること。
import { test } from "node:test";
import assert from "node:assert/strict";
import { PHASES, STEPS, phaseOf } from "../js/ui.js";

test("6つの段は、どれも1つの区切りに入る", () => {
  const all = PHASES.flatMap((p) => p.steps).sort((a, b) => a - b);
  assert.deepEqual(all, STEPS.map((_, i) => i));
});

test("区切りは段の順に進み、戻らない", () => {
  const seq = STEPS.map((_, i) => phaseOf(i));
  assert.deepEqual(seq, [0, 0, 0, 1, 1, 2]);
});

test("範囲外の段は端の区切りに丸める", () => {
  assert.equal(phaseOf(-1), 0);
  assert.equal(phaseOf(99), PHASES.length - 1);
});
