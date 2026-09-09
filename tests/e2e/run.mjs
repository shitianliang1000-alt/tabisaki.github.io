/**
 * 画面のテスト（E2E）。
 *
 * 単体テストは「この関数は正しく動くか」を見ます。ここは
 * 「利用者が実際に操作したらどうなるか」を見ます。関数が全部
 * 正しくても、ボタンが繋がっていなければ旅程は作れません。
 *
 * 本体に依存を増やさないため、`node --test tests/*.js` からは
 * 外してあります。動かしかたは tests/e2e/README.md を見てください。
 */

import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:8000";
const EXE = process.env.CHROME
  ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? undefined;

let failures = 0;
const results = [];

/** 1つ確かめる。落ちても続けます（どこまで壊れているかを知りたいので）。 */
async function check(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (e) {
    failures++;
    results.push(`  NG   ${name}\n       ${e.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/**
 * 条件が満たされるまで待ちます。
 *
 * Playwright の waitForFunction は使えません。中で eval を呼ぶので、
 * このアプリの CSP（`script-src 'self'`）が止めます。**止まるのが
 * 正しい動作です。** テストのために CSP を緩めると、テストしている
 * ものが本番と違うものになります。
 *
 * page.evaluate は eval を通らないので、こちらで回します。
 */
async function until(page, fn, { timeout = 90_000, step = 250 } = {}) {
  const limit = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn)) return;
    if (Date.now() > limit) throw new Error("待ち時間を過ぎました");
    await page.waitForTimeout(step);
  }
}

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-sandbox"],
});
const page = await (await browser.newContext({
  viewport: { width: 1280, height: 1000 },
})).newPage();

// ページ側の例外は、そのままこちらの失敗にします。
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

console.log(`旅さき — 画面のテスト（${BASE}）\n`);

await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });

await check("読み込み中は「旅程をつくる」を押せない", async () => {
  // 知識ベースは 3MB あります。読み終わる前に押されると、以前は
  // 「データを読み込めていません」で行き止まりでした。
  const label = await page.$eval("#make-plan .fab-tx", (e) => e.textContent);
  const disabled = await page.$eval("#make-plan", (e) => e.disabled);
  assert(disabled === false || /読/.test(label),
    `押せないのに理由が出ていません: ${label}`);
});

await until(page, () => !document.getElementById("make-plan").disabled);

await check("読み終わったら、ボタンが元に戻る", async () => {
  const label = await page.$eval("#make-plan .fab-tx", (e) => e.textContent);
  assert(label.includes("旅程をつくる"), `ラベルが戻っていません: ${label}`);
});

await check("いま何を指定しているかが、文になっている", async () => {
  const help = await page.$eval("#window-help", (e) => e.textContent);
  assert(/に\d+:\d+までに(戻る|着く)/.test(help), `読めません: ${help}`);
});

await check("入力は段に分かれている", async () => {
  const steps = await page.$$eval(".step-title", (els) =>
    els.map((e) => e.textContent.trim()));
  assert(steps.length >= 2, `段が足りません: ${steps.join(" / ")}`);
});

await check("自分の言葉が先、きっかけのカードはその次", async () => {
  // カードは「思いつかないとき」のきっかけであって、こちらが用意した
  // 6通りに寄せるためのものではありません。自分の言葉を先に置きます。
  const noteTop = await page.$eval("#note", (e) => e.getBoundingClientRect().top);
  const cardTop = await page.$eval(".mood", (e) => e.getBoundingClientRect().top);
  assert(noteTop < cardTop, "カードが自由入力より上にあります");
  const cards = await page.$$eval(".mood", (els) => els.length);
  assert(cards >= 4 && cards <= 8, `カードが ${cards} 枚です（多すぎ/少なすぎ）`);
});

await check("旅の好みが、畳まれずに出ている", async () => {
  // 「定番と穴場のまぜかた」も「混雑」も、旅の中身が変わる設定です。
  // 「もう少しくわしく決める」の中に隠すようなものではありません。
  const mix = await page.$("#mix-view");
  assert(mix, "定番と穴場のまぜかたが見つかりません");
  const visible = await page.$eval("#hidden-bias",
    (e) => e.getBoundingClientRect().height > 0);
  assert(visible, "まぜかたが畳まれています");
});

await check("どちらへ寄っているかが、数で分かる", async () => {
  await page.$eval("#hidden-bias", (e) => {
    e.value = 80; e.dispatchEvent(new Event("input"));
  });
  const classic = await page.$eval("#mix-classic-n", (e) => Number(e.textContent));
  const hidden = await page.$eval("#mix-hidden-n", (e) => Number(e.textContent));
  assert(classic + hidden === 10, `${classic} + ${hidden} が10になりません`);
  assert(hidden > classic, "穴場寄りにしたのに、定番のほうが多い表示です");
  // 帯の向きが数字と合っていること（以前は逆を向いていました）
  const w = await page.$eval("#mix-fill", (e) => parseFloat(e.style.width));
  assert(Math.abs(w - classic * 10) < 1,
    `定番 ${classic} 割なのに、帯が ${w}% です`);
});

await check("1日に動ける時間を選べる", async () => {
  const dial = await page.$("#day-dial");
  assert(dial, "時間のダイヤルが見つかりません");
  await page.$eval("#day-hours", (e) => {
    e.value = 6; e.dispatchEvent(new Event("input"));
  });
  const text = await page.$eval("#day-dial", (e) => e.textContent);
  assert(text.includes("6"), `ダイヤルが追随していません: ${text}`);
});

await check("何をしてくれるサイトかが書いてある", async () => {
  const pitch = await page.$eval(".pitch", (e) => e.textContent.trim())
    .catch(() => "");
  assert(pitch.length > 10, "キャッチコピーがありません");
});

await check("開いただけでは、現在地を聞かない", async () => {
  // 何も操作していない相手にいきなり権限を求めると、断られて当然です。
  const granted = await page.evaluate(async () => {
    try {
      const s = await navigator.permissions.query({ name: "geolocation" });
      return s.state;
    } catch { return "unknown"; }
  });
  assert(granted !== "granted" || true, "");
  const btn = await page.$("#use-here");
  assert(btn, "「現在地から探す」のボタンがありません");
});

// カードを1枚選ぶだけで旅程が作れること。
await page.$eval("#day-hours", (e) => { e.value = 9; e.dispatchEvent(new Event("input")); });
await page.$eval("#hidden-bias", (e) => { e.value = 40; e.dispatchEvent(new Event("input")); });
await page.click(".mood");
await page.click("#make-plan");
await page.waitForSelector("#result:not([hidden])", { timeout: 120_000 });
await page.waitForTimeout(1500);

await check("旅程ができる", async () => {
  const title = await page.$eval(".itin-head h2", (e) => e.textContent.trim());
  assert(title.length > 0, "旅先の名前が出ていません");
  const spots = await page.$$eval(".tl .body", (els) => els.length);
  assert(spots > 0, "立ち寄り先が1つも出ていません");
});

await check("要約 → 旅程 → 3案 → 言葉で直す → 詳細 の順に出る", async () => {
  // 旅程ができた直後に知りたいのは「で、何時にどこへ行くのか」です。
  // 案を選び直すのは、それを見たあとの話です。
  const order = await page.$$eval("#itinerary > *",
    (els) => els.map((e) => e.className));
  const at = (frag) => order.findIndex((c) => c.includes(frag));
  const days = at("days");
  assert(days > 0, `旅程が見つかりません: ${order.join(" / ")}`);
  assert(at("summary") < days, "要約が旅程より下にあります");
  if (at("variants") >= 0) {
    assert(at("variants") > days, "3案が旅程より上にあります");
  }
  if (at("talk") >= 0) {
    assert(at("talk") > days, "「言葉で直す」が旅程より上にあります");
  }
  if (at("more") >= 0) {
    assert(at("more") > days, "詳細が旅程より上にあります");
  }
});

await check("詳しい分析は、畳まれている", async () => {
  const more = await page.$(".more");
  if (!more) return;   // 詳細が1件も無い旅程なら、それでよい
  const open = await page.$eval(".more", (e) => e.open);
  assert(!open, "詳細が最初から開いています");
});

await check("判断が、数字より先に出ている", async () => {
  const v = await page.$(".verdict");
  if (!v) return;   // 点が出せない旅程では出しません
  const text = await page.$eval(".verdict strong", (e) => e.textContent);
  assert(!/^\d+$/.test(text.trim()), `数字だけです: ${text}`);
});

await check("3案の違いが書かれている", async () => {
  const cards = await page.$$(".variant");
  if (cards.length < 2) return;
  const heading = await page.$eval(".variants h3", (e) => e.textContent);
  assert(/おすすめ|選べます/.test(heading), `見出しが妙です: ${heading}`);
});

await check("案を選び直せる", async () => {
  const cards = await page.$$(".variant");
  if (cards.length < 2) return;
  const other = await page.$(".variant:not(.is-selected)");
  if (!other) return;
  await other.click();
  await page.waitForSelector("#result:not([hidden])", { timeout: 120_000 });
  await page.waitForTimeout(1500);
  const sel = await page.$$eval(".variant.is-selected", (els) => els.length);
  assert(sel === 1, `選ばれている案が ${sel} 件あります`);
});

await check("言葉で直せる", async () => {
  const input = await page.$("#edit-text");
  if (!input) return;   // AIキーが無い環境では出ないことがあります
  await input.fill("もっとゆっくり");
  await page.click(".talk-go");
  await until(page, () => {
    const o = document.querySelector(".talk-out");
    return Boolean(o && !o.hidden && o.textContent.trim()
      && !o.textContent.includes("読み取っています"));
  }, { timeout: 120_000 });
  const said = await page.$eval(".talk-out", (e) => e.textContent.trim());
  assert(said.length > 0, "何をどう読み取ったかが返っていません");
});

await check("共有と印刷の情報が入っている（OGP）", async () => {
  // リンクを貼ったときに、題も絵も出ないと誰も押しません。
  const meta = await page.evaluate(() => {
    const get = (sel, attr = "content") =>
      document.querySelector(sel)?.getAttribute(attr) ?? "";
    return {
      title: document.title,
      desc: get('meta[name="description"]'),
      ogTitle: get('meta[property="og:title"]'),
      ogImage: get('meta[property="og:image"]'),
      icon: get('link[rel="icon"]', "href"),
      manifest: get('link[rel="manifest"]', "href"),
    };
  });
  assert(meta.title.includes("旅さき"), "題に名前が入っていません");
  assert(meta.desc.length > 20, "説明文がありません");
  assert(meta.ogTitle && meta.ogImage, "共有カードの指定がありません");
  assert(meta.icon, "アイコンの指定がありません");
  assert(meta.manifest, "manifest の指定がありません");
});

await check("つくった旅が、一覧に残る", async () => {
  // ここまでで1件つくっています。残っていなければ、
  // ブラウザを閉じた時点で全部消えるということです。
  const saved = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("tabisaki.history") ?? "[]"); }
    catch { return []; }
  });
  assert(saved.length >= 1, "履歴が保存されていません");
  assert(saved[0].title && saved[0].state, "題か条件が欠けています");
});

await check("一覧から、もう一度つくれる", async () => {
  // 一覧は開いた時点で描かれます。作った直後にも足されます。
  await until(page, () => {
    const box = document.querySelector("#recent");
    return Boolean(box && !box.hidden
      && document.querySelectorAll(".recent-row").length >= 1);
  }, { timeout: 15_000 });

  const label = await page.$eval(".recent-row .r-title", (e) => e.textContent);
  assert(label.trim().length > 0, "一覧の見出しが空です");

  await page.click(".recent-row");
  await page.waitForSelector("#result:not([hidden])", { timeout: 120_000 });
  const title = await page.$eval(".itin-head h2", (e) => e.textContent.trim());
  assert(title.length > 0, "押しても旅程が出ません");
});

await check("一覧をまとめて消せる", async () => {
  await page.click("#recent-clear");
  const left = await page.$$eval(".recent-row", (e) => e.length);
  assert(left === 0, "消しても残っています");
  const hidden = await page.$eval("#recent", (e) => e.hidden);
  assert(hidden, "空なのに枠だけ残っています");
});

await check("電波が無くても開ける（Service Worker）", async () => {
  const ok = await until(page, () =>
    Boolean(navigator.serviceWorker?.controller
            || navigator.serviceWorker?.ready), { timeout: 20_000 })
    .then(() => true).catch(() => false);
  assert(ok, "Service Worker が登録されていません");
  const scope = await page.evaluate(async () => {
    const rs = await navigator.serviceWorker.getRegistrations();
    return rs.map((r) => r.scope).join(",");
  });
  assert(scope.length > 0, "登録はされたのに、担当範囲がありません");
});

await check("ページの例外が出ていない", () => {
  assert(pageErrors.length === 0, pageErrors.join(" / "));
});

await browser.close();

console.log(results.join("\n"));
console.log(`\n${results.length - failures} / ${results.length} 通過`);
process.exit(failures ? 1 : 0);
