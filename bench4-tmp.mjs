import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
const spots = [];
for (const f of readdirSync("kb").filter(x=>x.startsWith("spots-"))) {
  for (const s of JSON.parse(readFileSync("kb/"+f,"utf8")).spots) spots.push(s);
}
const cats = [...new Set(spots.map(s=>s.category))];
const genres = [...new Set(spots.flatMap(s=>s.genres??[]))];
const regions = [...new Set(spots.map(s=>s.regionId))];
const ci = new Map(cats.map((c,i)=>[c,i]));
const gi = new Map(genres.map((g,i)=>[g,i]));
const ri = new Map(regions.map((r,i)=>[r,i]));

// 索引A: 説明なし・分類は番号・エリアは番号
const A = spots.map(s => [s.id, ri.get(s.regionId), s.name, ci.get(s.category),
  (s.genres??[]).map(g=>gi.get(g)), Math.round(s.fame_score??50),
  s.verified === false ? 0 : 1]);
// 索引B: 説明の先頭30字も入れる
const B = spots.map((s,i) => [...A[i], (s.description??"").slice(0,30)]);
const dump = (o) => JSON.stringify(o);
for (const [name, obj] of [["A（説明なし）", {cats,genres,regions,rows:A}],
                           ["B（説明30字）", {cats,genres,regions,rows:B}]]) {
  const raw = dump(obj);
  console.log(name, "raw", (raw.length/1048576).toFixed(2), "MB  gz",
    (gzipSync(raw).length/1024).toFixed(0), "KB");
}
// 説明が全体のどれくらいか
const descBytes = spots.reduce((n,s)=>n+(s.description?JSON.stringify(s.description).length:0),0);
const allBytes = spots.reduce((n,s)=>n+JSON.stringify(s).length,0);
console.log("description share:", Math.round(descBytes/allBytes*100)+"%");
// 説明で初めて当たる語の割合（ざっくり）
const words = ["温泉","海","絶景","美術館","カフェ","神社","歴史","夜景","город"];
for (const w of words.slice(0,8)) {
  let name=0, cat=0, desc=0;
  for (const s of spots) {
    if (s.name.includes(w)) name++;
    else if ((s.category??"").includes(w)) cat++;
    else if ((s.genres??[]).includes(w)) {}
    else if ((s.description??"").includes(w)) desc++;
  }
  console.log(`  ${w}: 名前${name} 分類${cat} 説明のみ${desc}`);
}
