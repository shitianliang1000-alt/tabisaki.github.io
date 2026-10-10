// 管理画面の「JSON で書き出す」で得た変更を、手元の kb/ に当てます。
//
//   node tools/apply_kb_edits.mjs edits.json
//
// GITHUB_TOKEN を Worker に入れていれば、管理画面の「PRにする」で
// 同じことが自動でできます。これは、その代わりの手順です。
// 当て方は server/kbedit.js（PR にするときと同じ）です。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, shardsFor } from "../server/kbedit.js";

const file = process.argv[2];
if (!file) { console.error("使いかた: node tools/apply_kb_edits.mjs edits.json"); process.exit(2); }
const doc = JSON.parse(readFileSync(file, "utf8"));
const edits = Array.isArray(doc) ? doc : doc.edits;

const root = new URL("../", import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), "utf8");
const index = read("kb/index.json");
const shards = new Map(shardsFor(JSON.parse(index), edits).map((f) => [f, read(`kb/${f}`)]));
const names = read("kb/names.json");

const out = applyEdits({ index, shards, names, edits });
for (const [path, text] of out.files) writeFileSync(join(root, path), text);
console.log(`当てた変更 ${out.applied.length}件、当てられなかった変更 ${out.skipped.length}件`);
for (const s of out.skipped) console.log(`  - ${s.name || s.id}: ${s.why}`);
