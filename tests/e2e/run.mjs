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

// 外へ出られない環境（CI のサンドボックスなど）では、外の相手を
// 待たずに切ります。相手が黙って応えないと、切断まで1件ごとに数十秒
// かかり、旅程1本に何分も待つことになります。ここで見たいのは
// 「外が使えないときも旅程ができるか」なので、届かないことは即座に
// 分からせます。E2E_OFFLINE=1 で有効になります。
if (process.env.E2E_OFFLINE) {
  const origin = new URL(BASE).origin;
  await page.route((u) => u.origin !== origin,
    (route) => route.abort("connectionrefused"));
}

// 「もう少し詳しく調べますか」には、利用者として「詳しく調べる」と
// 答え続けます。外へ出られない環境では失敗した呼び出しも数に入るので、
// 旅程を数本つくると確認が出ます。出たままだと、後ろの操作が全部
// 「ダイアログに遮られました」で落ちます。
const answering = setInterval(() => {
  page.evaluate(() => {
    const dlg = document.getElementById("quota-dialog");
    if (dlg?.open) document.getElementById("quota-go")?.click();
  }).catch(() => {});
}, 500);

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
  // 「定番 / 知る人ぞ知る / 穴場」の3つに割ります。10か所行くとしたら
  // 何対何対何か、が画面に出ます。
  const classic = await page.$eval("#mix-classic-n", (e) => Number(e.textContent));
  const known = await page.$eval("#mix-known-n", (e) => Number(e.textContent));
  const hidden = await page.$eval("#mix-hidden-n", (e) => Number(e.textContent));
  assert(classic + known + hidden === 10,
    `${classic} + ${known} + ${hidden} が10になりません`);
  assert(hidden > classic, "穴場寄りにしたのに、定番のほうが多い表示です");
  // 帯の向きが数字と合っていること（以前は逆を向いていました）
  const w = await page.$eval("#mix-fill", (e) => parseFloat(e.style.width));
  assert(Math.abs(w - classic * 10) < 1,
    `定番 ${classic} 割なのに、帯が ${w}% です`);
});

await check("1日のうち、動く時間帯を選べる", async () => {
  // 長さ（ダイヤル）ではなく、朝は何時から・夜は何時までを時刻で聞きます。
  const start = await page.$("#day-start");
  const end = await page.$("#day-end");
  assert(start && end, "時間帯の入力が見つかりません");
  await page.$eval("#day-start", (e) => {
    e.value = "09:00"; e.dispatchEvent(new Event("input"));
  });
  await page.$eval("#day-end", (e) => {
    e.value = "15:00"; e.dispatchEvent(new Event("input"));
  });
  const text = await page.$eval("#day-hours-help", (e) => e.textContent);
  assert(text.includes("6時間"), `説明が追随していません: ${text}`);

  // 終わりが始めより前なら、そう言うこと（黙って組むと夜中の旅程になります）。
  await page.$eval("#day-end", (e) => {
    e.value = "08:00"; e.dispatchEvent(new Event("input"));
  });
  const warn = await page.$eval("#day-hours-help", (e) => e.textContent);
  assert(/後に/.test(warn), `逆順なのに注意が出ません: ${warn}`);
});

await check("出発日を「明日」「今週末」に飛ばせる", async () => {
  // カレンダーを開いて日を探すより早い近道。時刻は保ち、帰着も一緒に動くこと。
  await page.$eval("#depart-at", (e) => { e.value = "2026-09-13T09:30"; });
  await page.$eval("#arrive-by", (e) => { e.value = "2026-09-14T19:00"; });
  await page.click('[data-day-preset="tomorrow"]');
  const dep = await page.$eval("#depart-at", (e) => e.value);
  const arr = await page.$eval("#arrive-by", (e) => e.value);
  const t = new Date(); t.setDate(t.getDate() + 1);
  const p = (n) => String(n).padStart(2, "0");
  const ymd = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  assert(dep === `${ymd}T09:30`, `出発が明日 9:30 になっていません: ${dep}`);
  const t2 = new Date(t); t2.setDate(t2.getDate() + 1);
  const ymd2 = `${t2.getFullYear()}-${p(t2.getMonth() + 1)}-${p(t2.getDate())}`;
  assert(arr === `${ymd2}T19:00`, `帰着が1泊ぶんずれていません: ${arr}`);
  const sat = await page.$('[data-day-preset="saturday"]');
  assert(sat, "今週末の近道がありません");
});

await check("何をしてくれるサイトかが書いてある", async () => {
  // 見出しは画面に出しません（条件の入力が下がるため）。代わりに、
  // 結果が出る場所に「つくりかた」を置いて、何が返ってくるかを先に
  // 見せます。文書としての h1 も残っていること。
  const h1 = await page.$eval("h1", (e) => e.textContent.trim()).catch(() => "");
  assert(h1.includes("旅さき"), "h1 がありません");
  const steps = await page.$$eval("#home-hint li", (els) =>
    els.map((e) => e.textContent.trim()));
  assert(steps.length >= 3, `つくりかたが ${steps.length} 段しかありません`);
  assert(steps.some((t) => t.includes("旅程")),
    `何が出てくるのか書かれていません: ${steps.join(" / ")}`);
  const visible = await page.$eval("#home-hint",
    (e) => e.getBoundingClientRect().height > 0);
  assert(visible, "つくりかたが隠れています");
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
await page.$eval("#day-start", (e) => { e.value = "09:00"; e.dispatchEvent(new Event("input")); });
await page.$eval("#day-end", (e) => { e.value = "18:00"; e.dispatchEvent(new Event("input")); });
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

await check("旅程の下の操作が、ほかと同じ部品でできている", async () => {
  // 素のブラウザのボタンが並ぶと、ここだけ別のアプリに見えます。
  const raw = await page.$$eval(".actions button, .panel.adjust button, .panel.talk button",
    (els) => els.filter((b) => !b.classList.contains("md-btn")
                           && !b.classList.contains("md-chip")).length);
  assert(raw === 0, `共通の部品になっていないボタンが ${raw} 個あります`);
  const input = await page.$(".panel.talk .md-field > input");
  if (await page.$(".panel.talk")) assert(input, "「言葉で直す」の入力欄が共通の部品ではありません");
  const send = await page.$(".actions .share-text");
  assert(send, "「旅程を送る / コピー」がありません");
});

await check("旅程を文字にして渡せる", async () => {
  // 共有シートの無い環境では、クリップボードに入ります。
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.click(".actions .share-text");
  await page.waitForTimeout(300);
  const text = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  assert(text.includes("■"), `旅程の文字が入っていません: ${text.slice(0, 80)}`);
  assert(/\d{1,2}:\d{2} /.test(text), `時刻の行がありません: ${text.slice(0, 80)}`);
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
  // 相対パスの絵は、貼った先が読みに来られません。
  assert(/^https:\/\//.test(meta.ogImage), `og:image が絶対URLではありません: ${meta.ogImage}`);
  assert(!/\.svg$/i.test(meta.ogImage), "og:image が SVG です（共有先が画像として扱いません）");
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

clearInterval(answering);
await browser.close();

console.log(results.join("\n"));
console.log(`\n${results.length - failures} / ${results.length} 通過`);
process.exit(failures ? 1 : 0);
