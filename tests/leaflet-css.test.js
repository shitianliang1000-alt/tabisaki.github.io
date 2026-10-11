// 地図の見た目（vendor/leaflet.css）が、JS に頼らずに効いているか。
//
// media="print" で読んで js/app.js が "all" に切り替える形にしたところ、
// app.js がそこまで届かない端末（公開直後に新しい index.html と前の版の
// app.js が組み合わさったときなど）で、この CSS が最後まで効かず、地図の
// タイルが市松模様に崩れました。index.html だけで効く形を守ります。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("leaflet.css は media を付けずに、ふつうの stylesheet として読む", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const links = [...html.matchAll(/<link\b[^>]*href="vendor\/leaflet\.css"[^>]*>/g)]
    .map((m) => m[0]);
  assert.equal(links.length, 1, "index.html に leaflet.css の link が1つある");
  assert.match(links[0], /rel="stylesheet"/);
  assert.doesNotMatch(links[0], /\bmedia=/, "media を付けると、JS が切り替えるまで効かない");
  assert.doesNotMatch(links[0], /\bdisabled\b/);
});
