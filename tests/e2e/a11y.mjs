/**
 * 読み上げ・色・構造のテスト。
 *
 * 画面のテスト（run.mjs）は「操作したらどうなるか」を見ます。ここは
 * **「読める状態か」**を見ます。目が見えにくい人、色の見分けがつき
 * にくい人、マウスを使わない人にとって、画面が使いものになるか。
 *
 * 旅行のアプリは、明るい屋外の、日の当たる画面で読まれます。
 * 薄い灰色の注意書きは、そこでいちばん先に消えます。
 *
 * axe-core（Deque）に判定させます。自分で「たぶん読める」と決めるより、
 * 比率を測ってもらうほうが確かです。
 *
 * 動かしかた（playwright-core と axe-core が要ります）:
 *
 *     npm i -D playwright-core axe-core
 *     python3 -m http.server 8000 &
 *     node tests/e2e/a11y.mjs
 *
 * CSP（script-src 'self'）があるので、axe は**同じ出どころから**配ります。
 * CSP を緩めて通すと、試しているものが本番と違うものになります。
 * Service Worker は止めます（間に入ると、配った axe が届きません）。
 */

import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const AXE = require.resolve("axe-core/axe.min.js");

const BASE = process.env.BASE_URL ?? "http://localhost:8000";
const EXE = process.env.CHROME
  ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? undefined;

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-sandbox"],
});

let failures = 0;

/**
 * 1つの画面を測ります。
 *
 * @param {string} name 画面の名前（落ちたときに出ます）
 * @param {{dark?:boolean, plan?:boolean, width?:number}} opts
 */
async function audit(name, { dark = false, plan = false, width = 1280 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: dark ? "dark" : "light",
    serviceWorkers: "block",
  });
  const page = await ctx.newPage();
  await page.route("**/__axe.js", (route) =>
    route.fulfill({ path: AXE, contentType: "application/javascript" }));
  // 外へは出ません。鍵が無くても旅程はできるので、測るには足ります。
  const origin = new URL(BASE).origin;
  await page.route((u) => u.origin !== origin,
    (route) => route.abort("connectionrefused"));

  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  const until = Date.now() + 90_000;
  while (await page.$eval("#make-plan", (e) => e.disabled)) {
    if (Date.now() > until) throw new Error("知識ベースの読み込みが終わりません");
    await page.waitForTimeout(200);
  }

  if (plan) {
    await page.click(".mood");
    await page.click("#make-plan");
    // 「もう少し詳しく調べますか」には、利用者として答え続けます。
    const answering = setInterval(() => {
      page.evaluate(() => {
        const dlg = document.getElementById("quota-dialog");
        if (dlg?.open) document.getElementById("quota-go")?.click();
      }).catch(() => {});
    }, 500);
    await page.waitForSelector("#result:not([hidden])", { timeout: 120_000 });
    await page.waitForTimeout(1500);
    clearInterval(answering);
  }

  await page.addScriptTag({ url: "/__axe.js" });
  const { violations } = await page.evaluate(async () =>
    await window.axe.run(document, { resultTypes: ["violations"] }));

  if (!violations.length) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  NG   ${name}`);
    for (const v of violations) {
      console.log(`       [${v.impact}] ${v.id}: ${v.help}`);
      for (const n of v.nodes.slice(0, 4)) {
        console.log(`         ${n.target.join(" ")}`);
        const why = (n.any[0] ?? n.all[0] ?? n.none[0])?.message;
        if (why) console.log(`           → ${why.split("\n")[0]}`);
      }
      if (v.nodes.length > 4) console.log(`         … ほか ${v.nodes.length - 4} 件`);
    }
  }
  await ctx.close();
}

console.log(`旅さき — 読み上げ・色・構造のテスト（${BASE}）\n`);

// 条件の画面と旅程の画面を、明暗それぞれと、携帯の幅で。
// 色は配色で変わり、重なりは幅で変わるので、1つでは足りません。
await audit("条件の画面（明るい配色）");
await audit("条件の画面（暗い配色）", { dark: true });
await audit("条件の画面（携帯の幅）", { width: 390 });
await audit("旅程の画面（明るい配色）", { plan: true });
await audit("旅程の画面（暗い配色）", { dark: true, plan: true });
await audit("旅程の画面（携帯の幅）", { width: 390, plan: true });

await browser.close();
console.log(failures ? `\n${failures} 画面に直すところがあります`
                     : "\nすべての画面で、指摘はありません");
process.exit(failures ? 1 : 0);
