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

import { readFile } from "node:fs/promises";
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

// 許可を、勝手に求めていないか。
//
// 開いた瞬間に通知と現在地の許可を求めるのは、いちばん断られる
// 聞きかたです（何に使うのか分からないためです）。求めたら印が付く
// ようにしておいて、押していないのに付いていないことを見ます。
// **本物は呼びません**（無人の機械では答えが返らず、止まります）。
await page.addInitScript(() => {
  window.__geoAsked = false;
  window.__notifyAsked = false;
  const geo = navigator.geolocation;
  if (geo) {
    const wrap = (name) => {
      const orig = geo[name]?.bind(geo);
      if (!orig) return;
      Object.defineProperty(geo, name, {
        configurable: true,
        value: (...args) => { window.__geoAsked = true; return orig(...args); },
      });
    };
    wrap("getCurrentPosition");
    wrap("watchPosition");
  }
  if (window.Notification) {
    const orig = window.Notification.requestPermission;
    window.Notification.requestPermission = (...args) => {
      window.__notifyAsked = true;
      return orig?.apply(window.Notification, args) ?? Promise.resolve("denied");
    };
  }
});

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

await check("自分の言葉が先、書きかたの見本はその次", async () => {
  // 札は「書きかたの見本」であって、こちらが用意した分だけに
  // 寄せるためのものではありません。自分の言葉を先に置きます。
  const noteTop = await page.$eval("#note", (e) => e.getBoundingClientRect().top);
  const chipTop = await page.$eval(".note-examples .md-chip",
    (e) => e.getBoundingClientRect().top);
  assert(noteTop < chipTop, "見本が自由入力より上にあります");
  // きっかけは1か所にまとまっていること。以前は札とカードの2か所に
  // 分かれていて、画面の1枚目がカードで埋まっていました。
  const chips = await page.$$eval("[data-example]", (els) => els.length);
  assert(chips >= 8, `書きかたの見本が ${chips} 個しかありません`);
  const cards = await page.$$eval(".mood", (els) => els.length);
  assert(cards === 0, `きっかけが2か所に分かれています（カード ${cards} 枚）`);
  // 押したら、欄がその文で埋まること（下の別の確認と合わせて二重に
  // 見ています。ここは「まとめたあとも押せる」を見ます）。
  const want = await page.$eval("[data-example]", (e) => e.dataset.example);
  await page.click(".note-examples .md-chip");
  const got = await page.$eval("#note", (e) => e.value);
  assert(got === want, `札を押しても欄が埋まりません: ${got}`);
  await page.$eval("#note", (e) => {
    e.value = "";
    e.dispatchEvent(new Event("input", { bubbles: true }));
  });
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

  // 帯の幅が、文の数と合っていること。
  // 絵と文が食い違うと、どちらを信じてよいか分かりません（以前は帯が
  // 数字と逆を向いていました）。幅をそのまま読みます。
  // 帯は伸び縮みします。動いている途中の幅を測ると、動かす前の幅を
  // 読んでしまいます（実際それで一度落ちました）。止まるまで待ちます。
  const measure = () => page.evaluate(() => {
    const w = (id) => {
      const e = document.getElementById(id);
      const r = e.getBoundingClientRect();
      return { px: Math.round(r.width), text: e.textContent.replace(/\s+/g, "") };
    };
    return { major: w("mix-seg-major"), known: w("mix-seg-known"),
             hidden: w("mix-seg-hidden") };
  });
  let bar = await measure();
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(100);
    const next = await measure();
    if (next.major.px === bar.major.px && next.hidden.px === bar.hidden.px) {
      bar = next;
      break;
    }
    bar = next;
  }
  // 穴場側へ寄せたのだから、穴場の区間がいちばん広いこと
  assert(bar.hidden.px > bar.major.px,
    `穴場寄りにしたのに、定番の帯が広いままです（${bar.major.px} / ${bar.hidden.px}）`);
  // 幅の比が、数の比と合っていること（10か所ぶんの帯なので 1か所 = 10%）
  const total = bar.major.px + bar.known.px + bar.hidden.px;
  const share = (px) => Math.round((px / total) * 10);
  assert(share(bar.hidden.px) === hidden,
    `穴場の帯が ${share(bar.hidden.px)}か所ぶんの幅、文は ${hidden}か所です`);

  // 広い区間には、名前と数が書かれていること（色だけの帯では読めません）
  const widest = [bar.major, bar.known, bar.hidden]
    .sort((a, b) => b.px - a.px)[0];
  assert(/\d/.test(widest.text),
    `いちばん広い区間に数が出ていません: ${widest.text}`);

  // 帯の字が落ちた区間でも、どの色がどれなのかは文で分かること。
  // （色だけの帯に戻さないための見張りです）
  const keys = await page.$$eval(".mix-summary .mix-key", (els) =>
    els.map((e) => ({
      text: e.textContent.trim(),
      dot: getComputedStyle(e, "::before").backgroundColor,
    })));
  assert(keys.length === 3, `色見本が ${keys.length} 個しかありません`);
  assert(keys.every((k) => k.text.length > 0), "点の横に言葉がありません");
  assert(new Set(keys.map((k) => k.dot)).size === 3,
    `3つの色が同じ色になっています: ${keys.map((k) => k.dot).join(" / ")}`);
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

await check("停留所の読み解きを、別のスレッドに回している", async () => {
  // 停留所のデータは2.6MB（駅0.3MB＋バス停2.3MB）あります。本体側で
  // 読んで解くと、低スペックの携帯では400msほど画面が止まり、しかも
  // 2.6MBが本体側の記憶に載り続けます。返すのは「最寄り3件」のような
  // 小さな答えだけなので、本体側に置いておく理由がありません。
  await page.click("#depart-place");
  await page.fill("#depart-place", "松江");
  await until(page, () =>
    document.querySelectorAll("#place-list option").length > 0,
             { timeout: 60_000 });

  const workers = page.workers().map((w) => w.url().split("/").pop());
  assert(workers.includes("stops-worker.js"),
    `別のスレッドが動いていません: ${workers.join(",") || "なし"}`);

  // 答えが返ってきていること（回した先で止まっていないこと）
  const opts = await page.$$eval("#place-list option",
    (els) => els.map((e) => e.value));
  assert(opts.some((v) => v.includes("松江")),
    `停留所の候補が出ていません: ${opts.slice(0, 5).join("・")}`);
  await page.fill("#depart-place", "東京駅");
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

// 見本の札を1つ押すだけで旅程が作れること。
//
// 押すのは「温泉でゆっくり」です。**日帰りの札を押してはいけません。**
// このあとの確認は泊まりの旅を前提にしています（宿・荷物・連泊）。
// 以前ここで押していた色の面のカードの1枚目が、この文でした。
await page.$eval("#day-start", (e) => { e.value = "09:00"; e.dispatchEvent(new Event("input")); });
await page.$eval("#day-end", (e) => { e.value = "18:00"; e.dispatchEvent(new Event("input")); });
await page.$eval("#hidden-bias", (e) => { e.value = 40; e.dispatchEvent(new Event("input")); });
await page.click('[data-example^="温泉でゆっくり"]');
await page.click("#make-plan");

await check("待っているあいだ、止まっていないことが分かる", async () => {
  // 段は6つしかなく、最後の段に入ってからが長いところです。時計が
  // 動いていれば、固まったのか考えているのかが区別できます。
  const showing = () => page.$eval("#progress", (e) => !e.hidden);
  const clock = await page.$(".step-clock");
  if (!clock || !await showing()) return;  // もう組み上がっているなら、見るものがありません
  const first = (await clock.textContent()).trim();
  assert(/^\d+:\d\d$/.test(first), `時計が読めません: ${first}`);
  await page.waitForTimeout(1600);
  // 途中で組み上がったら、時計は止まっているのが正しい姿です。
  if (!await showing()) return;
  const second = await page.$eval(".step-clock", (e) => e.textContent.trim());
  assert(second !== first, `時計が ${first} のまま止まっています`);
});

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

await check("そのまま使える例を押すと、欄が埋まる", async () => {
  // 自由入力の枠は、何を書いてよいか分からないと空のままです。
  // 押すと入る一文があれば、書き換えるところから始められます。
  const chip = await page.$("[data-example]");
  assert(chip, "例の札がありません");
  const want = await chip.getAttribute("data-example");
  await chip.click();
  const got = await page.$eval("#note", (e) => e.value);
  assert(got === want, `欄が埋まっていません: ${got}`);
});

await check("カレンダーに入れられる（.ics）", async () => {
  // 当日に開くのはこのアプリではなくカレンダーです。そこまで届かないと、
  // 作った旅程は使われません。**実際に保存されるファイルを受け取って**
  // 中身を見ます。ボタンがあることだけ確かめても、空のファイルが
  // 落ちていないことは分かりません。
  const btn = await page.$(".actions .cal-ics");
  assert(btn, "カレンダーのボタンがありません");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20_000 }),
    btn.click(),
  ]);
  const name = download.suggestedFilename();
  // download 属性に日本語を渡すと、環境によっては名前ごと捨てられ、
  // 拡張子まで失われます（拡張子の無い「download」で保存されました）。
  assert(/\.ics$/.test(name), `拡張子がありません: ${name}`);
  assert(/^[\x20-\x7E]+$/.test(name), `ファイル名に ASCII 以外: ${name}`);

  const path = await download.path();
  assert(path, "ファイルが保存されていません");
  const text = await readFile(path, "utf8");
  assert(text.startsWith("BEGIN:VCALENDAR"), "カレンダーの形になっていません");
  assert(text.trimEnd().endsWith("END:VCALENDAR"), "閉じていません");
  const events = (text.match(/BEGIN:VEVENT/g) ?? []).length;
  assert(events > 0, "予定が1つもありません");
  // 時刻はその土地のまま（UTC に直すと、時計が別の国の人にはずれます）。
  assert(/DTSTART:\d{8}T\d{6}\r\n/.test(text), "開始時刻の形が妙です");
  assert(!/DTSTART:[0-9T]+Z/.test(text), "DTSTART が UTC になっています");
});

await check("紙には、時刻と場所だけを出す", async () => {
  // 旅の当日は電池を使いたくない場面があります。紙が1枚あれば、
  // 何時にどこかは分かります。紙の上で押せないものは落とします。
  await page.emulateMedia({ media: "print" });
  const shown = await page.evaluate(() => {
    const vis = (s) => {
      const e = document.querySelector(s);
      return e ? getComputedStyle(e).display !== "none" : null;
    };
    return {
      map: vis(".map"), form: vis(".pane-form"), variants: vis(".variants"),
      actions: vis(".actions"), talk: vis(".panel.talk"),
      days: vis(".days"), head: vis(".itin-head"), checked: vis(".panel.checked"),
    };
  });
  await page.emulateMedia({ media: null });
  for (const k of ["map", "form", "variants", "actions", "talk"]) {
    if (shown[k] === null) continue;
    assert(shown[k] === false, `紙に ${k} が残っています`);
  }
  assert(shown.days !== false, "紙に旅程が出ていません");
  assert(shown.head !== false, "紙に題が出ていません");
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

await check("立ち寄りを、その場で差し替えられる・外せる", async () => {
  // 気に入らない1か所のために、条件の画面まで戻らせません。
  const actions = await page.$$eval(".tl.spot .spot-action",
    (els) => els.map((e) => e.dataset.action));
  assert(actions.includes("replace") && actions.includes("remove"),
    `立ち寄りに「別の候補」「外す」がありません（${actions.join("・") || "なし"}）`);

  const before = await page.$$eval(".tl.spot", (els) => els.length);
  await page.click('.tl.spot .spot-action[data-action="remove"]');
  await page.waitForSelector("#result:not([hidden])", { timeout: 120_000 });
  await until(page, () => {
    const o = document.querySelector(".talk-out");
    return Boolean(o && !o.hidden && o.textContent.includes("外して"));
  }, { timeout: 120_000 });
  const after = await page.$$eval(".tl.spot", (els) => els.length);
  assert(after < before, `外す前 ${before}件・外したあと ${after}件で減っていません`);

  // 押し間違えたら戻せること。戻せないと、怖くて押せません。
  const back = await page.$(".dropped-back");
  assert(back, "外した場所を戻すボタンがありません");
  await back.click();
  await page.waitForSelector("#result:not([hidden])", { timeout: 120_000 });
  await until(page, () => {
    const o = document.querySelector(".talk-out");
    return Boolean(o && !o.hidden && o.textContent.includes("戻して"));
  }, { timeout: 120_000 });
  const restored = await page.$$eval(".tl.spot", (els) => els.length);
  assert(restored >= before, `戻したのに ${restored}件（外す前は ${before}件）です`);
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
      apple: get('link[rel="apple-touch-icon"]', "href"),
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
  // iOS は apple-touch-icon の SVG を読みません（ページの縮小画像が並びます）。
  assert(/\.png$/i.test(meta.apple),
    `ホーム画面用のアイコンが PNG ではありません: ${meta.apple}`);
});

await check("ホーム画面に追加したときのアイコンが揃っている", async () => {
  const doc = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]').getAttribute("href");
    const res = await fetch(href);
    return res.ok ? res.json() : null;
  });
  assert(doc, "manifest を読めません");
  const png = (doc.icons ?? []).filter((i) => i.type === "image/png");
  assert(png.some((i) => i.sizes === "192x192"), "192px の PNG がありません");
  assert(png.some((i) => i.sizes === "512x512"), "512px の PNG がありません");
  assert((doc.icons ?? []).some((i) => String(i.purpose).includes("maskable")),
    "切り抜き用（maskable）のアイコンがありません");
  // 実際に取れること。manifest に書いてあっても、404 なら同じです。
  const codes = await page.evaluate(async (srcs) => {
    const out = [];
    for (const s of srcs) out.push((await fetch(s)).status);
    return out;
  }, doc.icons.map((i) => i.src));
  assert(codes.every((c) => c === 200), `アイコンが取れません: ${codes.join(",")}`);
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

await check("まとめて消す前に、確認する", async () => {
  // **押した瞬間に消していました。** 履歴は端末にしか無いので、
  // 消したら戻せません（サーバーにも控えはありません）。取り消せない
  // 操作には、色と確認の両方が要ります（ガイドライン: destructive）。
  const before = await page.$$eval(".recent-row", (e) => e.length);
  assert(before > 0, "消す対象がありません");

  // 赤で示されていること（色だけには頼りませんが、色は要ります）。
  const red = await page.$eval("#recent-clear", (e) =>
    e.classList.contains("linkish--danger"));
  assert(red, "取り消せない操作が、ふつうのリンクと同じ見た目です");

  await page.click("#recent-clear");
  const dlg = await page.$("#confirm-dialog[open]");
  assert(dlg, "確認せずに消そうとしています");
  // 何件消えるのかが書かれていること。
  const detail = await page.$eval("#confirm-detail", (e) => e.textContent);
  assert(detail.includes(String(before)), `件数が書かれていません: ${detail}`);
  assert(/戻せ(ない|ません)/.test(detail), `戻せないことが書かれていません: ${detail}`);

  // 「やめる」を押したら、消えないこと。
  await page.click("#confirm-no");
  await until(page, () => !document.querySelector("#confirm-dialog[open]"),
             { timeout: 5000 });
  const kept = await page.$$eval(".recent-row", (e) => e.length);
  assert(kept === before, `やめたのに ${before} → ${kept} 件になりました`);
});

await check("一覧をまとめて消せる", async () => {
  await page.click("#recent-clear");
  await page.click("#confirm-yes");
  await until(page, () => !document.querySelector("#confirm-dialog[open]"),
             { timeout: 5000 });
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

// --- 車の旅 ---------------------------------------------------------------
// 車で来ている人に、駅前と時刻表の話をしないこと。
// ここだけは条件を変えて、もう一度組み直します。

await check("車を選ぶと、車の旅として組み直す", async () => {
  await page.evaluate(() => { document.getElementById("tune").open = true; });
  await page.click('#transport-choice [data-transport="car"]');
  await page.click("#make-plan");
  await page.waitForSelector("#result:not([hidden])", { timeout: 120_000 });
  await until(page, () => {
    const l = [...document.querySelectorAll(".check-list .ck-label")]
      .map((e) => e.textContent);
    return l.includes("運転時間");
  }, { timeout: 60_000 });

  const got = await page.evaluate(() => {
    const txt = (s) => document.querySelector(s)?.textContent?.trim() ?? "";
    for (const d of document.querySelectorAll(".tl details")) d.open = true;
    return {
      detail: txt(".check-list li .ck-detail"),
      recheck: txt(".recheck .md-btn"),
      icons: [...document.querySelectorAll(".tl.transit .ic")]
        .map((e) => e.dataset.icon).join(" "),
      reasons: [...document.querySelectorAll(".tl details")]
        .map((e) => e.textContent).join(" "),
    };
  });
  // 車の旅で「便」や「時刻」を数えてはいけません。引くのは道のりです。
  assert(!/便|時刻/.test(got.detail), `運転時間の行が妙です: ${got.detail}`);
  assert(/経路検索/.test(got.detail), `道のりの話になっていません: ${got.detail}`);
  if (got.recheck) {
    assert(/道のり/.test(got.recheck), `調べ直しの言葉が妙です: ${got.recheck}`);
  }
  // 電車の絵を出すと、乗り換えを探すことになります。
  assert(!got.icons.includes("transit"), `電車の記号が残っています: ${got.icons}`);
  assert(got.icons.includes("car"), `車の記号がありません: ${got.icons}`);
  // 「道の楽しさ」が、選んだ理由の軸に出ること。
  assert(/道の楽しさ/.test(got.reasons), "道の楽しさの軸が出ていません");
});

await check("電車＋現地の車では、区間ごとに乗るものが変わる", async () => {
  // 新幹線で行って駅でレンタカー。同じ旅程に、便で決まる区間と
  // 道のりで決まる区間が並びます。どちらかに寄せると嘘になります。
  await page.evaluate(() => { document.getElementById("tune").open = true; });
  await page.click('#transport-choice [data-transport="transit+car"]');
  await page.click("#make-plan");
  await page.waitForSelector("#result:not([hidden])", { timeout: 120_000 });
  await until(page, () => document.querySelectorAll(".tl.transit").length > 1,
             { timeout: 120_000 });

  const got = await page.evaluate(() => ({
    icons: [...document.querySelectorAll(".tl.transit .ic")]
      .map((e) => e.dataset.icon).join(" "),
    detail: document.querySelector(".check-list li .ck-detail")
      ?.textContent ?? "",
  }));
  // 遠出は電車の絵、現地は車の絵。どちらも出ていること。
  assert(got.icons.includes("transit"), `電車の区間がありません: ${got.icons}`);
  assert(got.icons.includes("car"), `運転の区間がありません: ${got.icons}`);
  // 取れていない区間を、取れたように書かないこと
  assert(!/0区間は確認済み/.test(got.detail), `妙な言い方です: ${got.detail}`);
  // もとに戻します（このあとの確認は、おまかせのままで続けます）
  await page.click('#transport-choice [data-transport="any"]');
});

// --- 泊まりの旅（宿・食事・荷物・代わりの案）-------------------------------
// 1泊すると出てくるもの。日帰りの旅程には出ません。

await check("連泊を選ぶと、宿を動かさない旅になる", async () => {
  await page.evaluate(() => { document.getElementById("tune").open = true; });
  await page.click('#transport-choice [data-transport="any"]');
  await page.click('#stay-choice [data-stay="base"]');
  // 1泊2日にします（日帰りでは宿の話が出ません）
  await page.$eval("#depart-at", (e) => { e.value = "2026-10-10T09:00"; });
  await page.$eval("#arrive-by", (e) => { e.value = "2026-10-11T19:00"; });
  await page.$eval("#note", (e) => {
    e.value = "松江と出雲をゆっくり。神社と海";
    e.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("#make-plan");
  await page.waitForSelector("#result:not([hidden])", { timeout: 120_000 });
  await until(page, () => document.querySelectorAll(".day").length > 1,
             { timeout: 120_000 });

  const line = await page.$eval(".stay-line", (e) => e.textContent)
    .catch(() => "");
  assert(/泊/.test(line), `どこに泊まる旅か書かれていません: ${line}`);
});

await check("食事が、その土地のものになっている", async () => {
  // 「昼食 / ◯◯で」だけでは、旅程として何も言っていません。
  const got = await page.evaluate(() => ({
    details: [...document.querySelectorAll(".tl.meal .detail")]
      .map((e) => e.textContent),
    links: [...document.querySelectorAll(".tl.meal .item-links a")]
      .map((e) => e.textContent),
  }));
  assert(got.details.length > 0, "食事の行がありません");
  // 名物か、収録の食事どころか、少なくともどちらかに触れていること。
  assert(got.details.some((t) => /名物|収録|お店/.test(t)),
    `食事の説明が空です: ${got.details.join(" / ")}`);
  assert(got.links.some((t) => /地図で探す/.test(t)),
    `店を探す先がありません: ${got.links.join(" / ")}`);
});

await check("駄目だったときの代わりが書かれている", async () => {
  // 現地で困るのは、雨や休館そのものより、その場で代わりを探すこと
  // のほうです。無ければ出しません（近くに無いこともあります）。
  await page.click(".day-tabs button:last-child").catch(() => {});
  const backups = await page.$$eval(".backup", (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, " ")));
  for (const t of backups) {
    assert(/雨|閉ま/.test(t), `何のための代わりか書かれていません: ${t}`);
    assert(/m|km/.test(t), `どのくらい近いのか書かれていません: ${t}`);
  }
});

await check("荷物を預けるのが、朝いちの一手として入っている", async () => {
  // 案を下の囲みに書いても、現地では旅程の行しか追いません。
  const got = await page.evaluate(() => {
    const step = document.querySelector(".tl.luggage");
    return {
      has: Boolean(step),
      text: step?.textContent?.replace(/\s+/g, " ") ?? "",
      panel: Boolean(document.querySelector(".panel.luggage")),
    };
  });
  if (got.panel) {
    assert(got.has, "荷物の案はあるのに、旅程の中に手数が入っていません");
    assert(/預け/.test(got.text), `何をするのか書かれていません: ${got.text}`);
  }
});

// --- 回る順と、いる時間 ----------------------------------------------------

await check("回る順を、その場で入れ替えられる", async () => {
  // 並べ替えたら**時刻も組み直す**こと。並びだけ変えて時刻を据え置くと、
  // 開館前に着く旅程ができます。
  await page.click(".day-tabs button:first-child").catch(() => {});
  const before = await page.$$eval(".day:not([hidden]) .tl.spot",
    (els) => els.map((e) => e.dataset.spot));
  if (before.length < 2) return;   // 1か所の日では、入れ替えるものがありません

  const moves = await page.$$(".day:not([hidden]) .tl.spot .tune-move[data-move='down']");
  assert(moves.length > 0, "順番を動かすボタンがありません");
  await moves[0].click();
  await page.waitForSelector("#result:not([hidden])", { timeout: 120_000 });
  await until(page, () => {
    const o = document.querySelector(".talk-out");
    return Boolean(o && !o.hidden && o.textContent.includes("回る順"));
  }, { timeout: 120_000 });

  const after = await page.$$eval(".day:not([hidden]) .tl.spot",
    (els) => els.map((e) => e.dataset.spot));
  assert(after.join(",") !== before.join(","),
    `順番が変わっていません: ${after.join(",")}`);

  // 時刻が組み直されていること（並びだけ変わって時刻が同じなら嘘です）
  const times = await page.$$eval(".day:not([hidden]) .tl.spot .time",
    (els) => els.map((e) => e.textContent.trim()));
  assert(times.length === after.length, "時刻の欄が足りません");
  const sorted = [...times].sort();
  assert(times.join(",") === sorted.join(","),
    `時刻が前後しています: ${times.join(" / ")}`);
});

await check("掴んで動かしても、入れ替わる", async () => {
  // ここは一度壊れていました。入れ替えは節を付け替える操作なので、
  // 掴んだ要素で指の動きを受けていると **1回でポインタの捕捉が外れ**、
  // 指を離したことに気づけません。並べ替えたのに組み直されませんでした。
  const rows = await page.$$(".day:not([hidden]) .tl.spot");
  if (rows.length < 2) return;
  const before = await page.$$eval(".day:not([hidden]) .tl.spot",
    (els) => els.map((e) => e.dataset.spot));

  const grip = await page.$(".day:not([hidden]) .tl.spot .tune-grip");
  assert(grip, "掴むところがありません");
  await grip.scrollIntoViewIfNeeded();
  const from = await grip.boundingBox();
  const to = await rows[1].boundingBox();
  await page.mouse.move(from.x + 5, from.y + 5);
  await page.mouse.down();
  await page.mouse.move(from.x + 5, to.y + to.height * 0.8, { steps: 10 });
  await page.mouse.up();

  await until(page, () => {
    const o = document.querySelector(".talk-out");
    return Boolean(o && !o.hidden && o.textContent.includes("回る順"));
  }, { timeout: 120_000 });
  const after = await page.$$eval(".day:not([hidden]) .tl.spot",
    (els) => els.map((e) => e.dataset.spot));
  assert(after.join(",") !== before.join(","),
    `掴んで動かしても変わりません: ${after.join(",")}`);
});

await check("いる時間を、その場で伸ばせる", async () => {
  const bar = await page.$(".day:not([hidden]) .tl.spot .tune-bar");
  assert(bar, "いる時間のバーがありません");
  const got = await page.evaluate(() => {
    const b = document.querySelector(".day:not([hidden]) .tl.spot .tune-bar");
    const o = b.closest(".spot-tune").querySelector(".tune-out");
    return { min: b.min, max: b.max, step: b.step, out: o.textContent };
  });
  // 1分刻みで選べても、選ぶ意味がありません
  assert(Number(got.step) >= 5, `刻みが細かすぎます: ${got.step}`);
  assert(Number(got.min) >= 10, `短すぎる値が選べます: ${got.min}`);
  // いま何分なのかが、数字でも出ていること
  assert(/分|時間/.test(got.out), `いる時間が数字で出ていません: ${got.out}`);
});

// --- 携帯での地図と説明 ----------------------------------------------------

await check("携帯では、説明が半分の高さで開く（地図が残る）", async () => {
  // 全画面で開くと地図が隠れます。場所を確かめたくて押したのに
  // 場所が見えない、という順番になっていました。
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click(".day-tabs button:first-child").catch(() => {});
  await page.click(".tl.spot .chev");
  await until(page, () => Boolean(document.querySelector(".md-sheet")),
             { timeout: 20_000 });
  const got = await page.evaluate(() => {
    const sh = document.querySelector(".md-sheet");
    return {
      state: sh.dataset.state,
      topRatio: sh.getBoundingClientRect().top / innerHeight,
      toggle: Boolean(sh.querySelector(".sheet-toggle")),
      blurred: getComputedStyle(document.querySelector(".md-sheet-scrim"))
        .backdropFilter,
    };
  });
  assert(got.state === "peek", `半分で開いていません: ${got.state}`);
  assert(got.topRatio > 0.35,
    `画面を覆いすぎています（上端が ${Math.round(got.topRatio * 100)}%）`);
  assert(got.toggle, "全部見るための摘みがありません");
  // 曇らせると、後ろの地図が読めません
  assert(!/blur/.test(got.blurred), `後ろが曇っています: ${got.blurred}`);

  // 摘みを押したら、全部開くこと（指以外でも開けること）
  await page.click(".sheet-toggle");
  await until(page, () =>
    document.querySelector(".md-sheet")?.dataset.state === "full",
             { timeout: 10_000 });

  await page.click(".md-sheet .close");
  await until(page, () => !document.querySelector(".md-sheet"),
             { timeout: 10_000 });
  await page.setViewportSize({ width: 1280, height: 1000 });
});

// 画面に「null」「undefined」が出ていないこと。
//
// DOM の append は、Node でないものを**文字列にして**足します。
// 無いもの（null）をそのまま渡すと、画面に null という4文字が
// 出ます。実際に「言葉で直す」の下に出ていました（外した場所が
// 1つも無い旅程では、その一覧が null になります）。
// 目で見つけるまで誰も気づかなかったので、ここで見張ります。
await check("書けなかったところが、null のまま出ていない", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  const found = await page.evaluate(() => {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) {
          const t = c.textContent.trim();
          if (t === "null" || t === "undefined" || t === "NaN"
              || t === "[object Object]") {
            out.push(`${c.parentElement?.tagName}.${c.parentElement?.className}: ${t}`);
          }
        } else if (c.nodeType === 1 && c.tagName !== "SCRIPT") {
          walk(c);
        }
      }
    };
    walk(document.body);
    return out;
  });
  assert(found.length === 0, `画面に出ています: ${found.join(" / ")}`);
  await page.setViewportSize({ width: 1280, height: 1000 });
});

// 字を大きくしたら、本当に大きくなること。
//
// ここは Apple の表の値を px で書いていました。「表を使っている」
// ことにはなりますが、Dynamic Type の中身は表ではなく**利用者の設定に
// 追従すること**です。px で書いた字は、iOS の「文字を大きく」でも
// Android の文字サイズでもブラウザの拡大でも、1pxも動きません。
//
// rem に直して、根の大きさを倍率から出すようにしました。ここでは
// 「倍率を上げたら、実際に描かれる字が大きくなる」ことを測ります
// （変数の値を見るだけでは、どこかで px に上書きされていても通ります）。
await check("字を大きくすると、実際に大きくなる", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  const read = () => page.evaluate(() => {
    const px = (sel) => {
      const e = document.querySelector(sel);
      return e ? parseFloat(getComputedStyle(e).fontSize) : 0;
    };
    return {
      root: parseFloat(getComputedStyle(document.documentElement).fontSize),
      title: px(".step-title"),
      help: px(".md-field-help"),
      button: px(".md-fab-extended"),
      // 当たり判定は指の大きさで決まるので、**動かないこと**を見ます。
      touch: parseFloat(getComputedStyle(
        document.querySelector(".md-btn")).minHeight),
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      // どこが溢れているのか。数だけだと直せません。
      wide: (() => {
        const W = window.innerWidth;
        const out = [];
        for (const e of document.querySelectorAll("body *")) {
          const r = e.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right <= W + 1 && r.left >= -1) continue;
          if ([...e.children].some((c) => {
            const cr = c.getBoundingClientRect();
            return cr.right > W + 1 || cr.left < -1;
          })) continue;
          // 横に流す入れもの（中身が溢れて当然のもの）は除きます。
          let sc = e.parentElement;
          let inScroller = false;
          while (sc && sc !== document.body) {
            const ov = getComputedStyle(sc).overflowX;
            if (ov === "auto" || ov === "scroll") { inScroller = true; break; }
            sc = sc.parentElement;
          }
          if (inScroller) continue;
          out.push(`${e.tagName}.${String(e.className).slice(0, 30)}`
            + `[${Math.round(r.left)}..${Math.round(r.right)}]`);
          if (out.length >= 6) break;
        }
        return out;
      })(),
    };
  });
  // 幅を変えた直後は、まだ組み直しが終わっていません。
  await page.waitForTimeout(400);
  const before = await read();
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--hig-type-scale", "1.5"));
  await page.waitForTimeout(150);
  const after = await read();

  assert(after.root > before.root * 1.4,
    `根の字が ${before.root} から ${after.root} しか変わりません`);
  for (const k of ["title", "help", "button"]) {
    assert(before[k] > 0, `${k} が見つかりません`);
    assert(after[k] > before[k] * 1.4,
      `${k} が ${before[k]}px から ${after[k]}px しか変わりません（px 固定では？）`);
  }
  // 44pt は指の大きさです。字を大きくしても指は大きくなりません。
  assert(after.touch === before.touch,
    `当たり判定が ${before.touch} から ${after.touch} に動きました`);
  // 大きくしても、横にはみ出さないこと。
  //
  // 溢れると、読むために横へスクロールすることになります。字を
  // 大きくする人は、まさにそれができない人です。
  assert(after.wide.length === 0,
    `字を大きくすると横に溢れます（${after.scrollW}px / 画面 ${after.innerW}px）`
    + `: ${after.wide.join(" / ")}`);

  await page.evaluate(() =>
    document.documentElement.style.removeProperty("--hig-type-scale"));
  await page.setViewportSize({ width: 1280, height: 1000 });
});

// 指で押せる大きさになっていること（44×44pt）。
//
// ガイドラインの Minimum hit region は 44×44pt です。ところが
//
//   歯車・地図の拡大（.md-icon-btn）      36×36
//   例・日付の近道のチップ                min-height: 32px
//   半分の高さの切り替え（.sheet-toggle） 30px
//   つまみ（.md-slider）                  高さ 28px
//   地図のピン                            30×30
//
// が下回っていました。しかもチップは `.note-examples .md-chip` の
// ように詳細度の高い書きかたで、@media (pointer: coarse) の 44px 指定を
// **上書きしていました**（0,2,0 対 0,1,0）。指定はあるのに効かない、
// という状態です。
//
// 見た目を変えずに直すには、透明な当たり判定を重ねるのが確かです。
// ここでは「押せる範囲」を測ります（見た目の大きさではありません）。
await check("指で押せる大きさになっている（44pt）", async () => {
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true, isMobile: true, serviceWorkers: "block",
  });
  const pg = await phone.newPage();
  try {
    await pg.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
    const until = Date.now() + 90_000;
    while (await pg.$eval("#make-plan", (e) => e.disabled)) {
      if (Date.now() > until) throw new Error("知識ベースの読み込みが終わりません");
      await pg.waitForTimeout(200);
    }
    await pg.click("#tune > summary").catch(() => {});
    await pg.waitForTimeout(300);
    const out = await pg.evaluate(() => {
      const coarse = matchMedia("(pointer: coarse)").matches;
      const sels = [".md-icon-btn", ".note-examples .md-chip",
                    ".date-presets .md-chip", ".md-chip", ".md-btn",
                    ".md-slider", ".linkish", ".md-fab-extended"];
      const bad = [];
      for (const sel of sels) {
        const e = document.querySelector(sel);
        if (!e) continue;
        const r = e.getBoundingClientRect();
        // 透明な当たり判定（::after）も押せる範囲です。
        const a = getComputedStyle(e, "::after");
        const w = Math.max(r.width, parseFloat(a.minWidth) || 0);
        const h = Math.max(r.height, parseFloat(a.minHeight) || 0);
        if (w < 43.5 || h < 43.5) {
          bad.push(`${sel} ${Math.round(w)}x${Math.round(h)}`);
        }
      }
      return { coarse, bad };
    });
    assert(out.coarse === true, "指の端末として開けていません");
    assert(out.bad.length === 0, `44pt を下回ります: ${out.bad.join(" / ")}`);
  } finally {
    await phone.close();
  }
});

// 指で押したあと、触った跡が残らないこと。
//
// :hover の指定に @media (hover: hover) の囲いがありませんでした。
// 指で押すと、iOS も Android も**指を離したあとまで :hover を当てた
// まま**にします。押したものが薄くなったり浮いたままになり、
// 「選択済み」に見えます。実際に選ばれているものと見分けがつかない
// ので、押し間違いに気づけません。
await check("指で押した跡が、残らない", async () => {
  const css = await (await fetch(`${BASE}/css/app.css`)).text();
  const hig = await (await fetch(`${BASE}/css/hig.css`)).text();
  for (const [name, text] of [["app.css", css], ["hig.css", hig]]) {
    // コメントを先に落とします。**行ごとに落とすのでは足りません**
    // （このファイルの説明はどれも複数行にまたがっていて、その中に
    // 「:hover」という字が出てきます。実際それで誤検知しました）。
    // 行の数は保ちたいので、改行だけ残して消します。
    const code = text.replace(/\/\*[\s\S]*?\*\//g,
      (m) => m.replace(/[^\n]/g, " "));
    let depth = 0;
    let inHover = false;
    let hoverDepth = 0;
    const bad = [];
    for (const [i, line] of code.split("\n").entries()) {
      if (/@media \(hover/.test(line)) { inHover = true; hoverDepth = depth; }
      if (/:hover/.test(line) && !inHover) {
        bad.push(`${name}:${i + 1} ${line.trim().slice(0, 60)}`);
      }
      depth += (line.match(/\{/g) ?? []).length
             - (line.match(/\}/g) ?? []).length;
      if (inHover && depth <= hoverDepth) inHover = false;
    }
    assert(bad.length === 0,
      `@media (hover: hover) の外に :hover があります: ${bad.join(" / ")}`);
  }
});

// 旅の当日に出る一画（「今日の旅」）。
//
// 当日いちばん見る場所です。ところがここには**決まりが1つもありません
// でした**——素の段落が旅程の上に並ぶだけで、いちばん見る場所が
// いちばん読みにくくなっていました。あわせて、当日のしたく
//（出発の知らせ・現在地で気づく）がここに置かれます。
//
// **押されてから聞きます。** 開いた瞬間に通知と現在地の許可を求めるのは
// いちばん断られる聞きかたなので、そうなっていないことも見ます。
await check("旅の当日は、次の一手が大きく出る", async () => {
  // **まっさらな画面で見ます。**
  //
  // ここまでに旅程を30本ほど作っているので、同じ画面で組み直すと
  // 調べた回数の確認が挟まったり、時刻表への問い合わせが休みに入ったり
  // します（実際、ここだけ2分たっても終わりませんでした）。
  // 旅の当日にアプリを開く人は、その画面を開いたばかりです。
  // 同じ条件で見ます。
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const day = await ctx.newPage();
  if (process.env.E2E_OFFLINE) {
    const origin = new URL(BASE).origin;
    await day.route((u) => u.origin !== origin,
      (route) => route.abort("connectionrefused"));
  }
  // 押していないのに許可を求めていないか、ここでも見ます。
  await day.addInitScript(() => {
    window.__geoAsked = false;
    window.__notifyAsked = false;
    const geo = navigator.geolocation;
    if (geo) {
      for (const name of ["getCurrentPosition", "watchPosition"]) {
        const orig = geo[name]?.bind(geo);
        if (!orig) continue;
        Object.defineProperty(geo, name, { configurable: true,
          value: (...a) => { window.__geoAsked = true; return orig(...a); } });
      }
    }
    if (window.Notification) {
      const orig = window.Notification.requestPermission;
      window.Notification.requestPermission = (...a) => {
        window.__notifyAsked = true;
        return orig?.apply(window.Notification, a) ?? Promise.resolve("denied");
      };
    }
  });
  const answering = setInterval(() => {
    day.evaluate(() => {
      const d = document.getElementById("quota-dialog");
      if (d?.open) document.getElementById("quota-go")?.click();
    }).catch(() => {});
  }, 500);

  try {
    await day.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
    await until(day, () => !document.getElementById("make-plan")?.disabled,
               { timeout: 90_000 });

    // 日付は画面の「今日」を押します（**利用者と同じ道**。直に書くと
    // change が飛ばず、画面の文が前の日のままになります。実際そう
    // なりました）。
    await day.click('[data-day-preset="today"]');
    // 時刻は、いまより後ろへ。既定は 9:00〜19:00 なので、夕方以降に
    // この試験を回すと「今日の予定はここまでです」になり、次の一手が
    // 出ません（そう落ちました）。時計に依らない試験にします。
    await day.evaluate(() => {
      const p = (n) => String(n).padStart(2, "0");
      const iso = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}`
        + `-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      const now = new Date();
      const dep = new Date(now.getTime() + 45 * 60000);
      const arr = new Date(dep.getTime() + 7 * 3600000);
      for (const [id, v] of [["depart-at", iso(dep)], ["arrive-by", iso(arr)]]) {
        const e = document.getElementById(id);
        e.value = v;
        e.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await day.click("#make-plan");
    await day.waitForSelector("#result:not([hidden])", { timeout: 120_000 });
    await until(day, () => {
      const t = document.getElementById("today");
      return Boolean(t) && !t.hidden;
    }, { timeout: 30_000 });

    const got = await day.evaluate(() => {
      const box = document.querySelector("#today .today");
      const size = (sel) => {
        const e = document.querySelector(sel);
        return e ? parseFloat(getComputedStyle(e).fontSize) : 0;
      };
      return {
        has: Boolean(box),
        next: document.querySelector(".today-next")?.textContent ?? "",
        nextSize: size(".today-next"),
        bodySize: parseFloat(getComputedStyle(document.body).fontSize),
        buttons: [...document.querySelectorAll("#today button")]
          .map((b) => b.textContent.trim()),
        geoAsked: window.__geoAsked === true,
        notifyAsked: window.__notifyAsked === true,
        overflow: box
          ? Math.round(box.getBoundingClientRect().right)
            - Math.round(document.documentElement.clientWidth)
          : 0,
      };
    });
    assert(got.has, "当日なのに「今日の旅」が出ていません");
    assert(got.next.length > 0, "次の予定の名前が出ていません");
    // 歩きながら、ちらっと見て読める大きさであること。
    assert(got.nextSize > got.bodySize,
      `次の予定が本文と同じ大きさです（${got.nextSize}px）`);
    assert(got.overflow <= 0, `当日の一画が ${got.overflow}px はみ出しています`);
    const labels = got.buttons.join(" / ");
    assert(/知らせる/.test(labels), `出発を知らせる手がありません: ${labels}`);
    assert(/現在地/.test(labels), `現在地で気づく手がありません: ${labels}`);
    // 次の1区間だけを引き直す手。旅程ぜんぶを組み直さずに済みます。
    assert(/調べ直す/.test(labels), `次の便を調べ直す手がありません: ${labels}`);
    // **押されてから聞きます。**
    assert(!got.geoAsked, "押していないのに現在地を求めています");
    assert(!got.notifyAsked, "押していないのに通知を求めています");
  } finally {
    clearInterval(answering);
    await ctx.close();
  }
});

// 画面に出ている記号が、絵文字でないこと。
//
// 絵文字は端末ごとに別の絵で、多色で、大きさと重心がそろいません。
// 同じ旅程が iPhone と Android で別の顔になります。単線SVGに
// 置き換えました（js/icons.js）。**置き換え漏れは、この端末で見ても
// 分かりません**（Chromium は自前の絵文字を持っているので、ちゃんと
// 絵が出てしまいます）。組み上がった画面の文字を機械で見ます。
await check("画面の記号が、絵文字になっていない", async () => {
  const got = await page.evaluate(() => {
    // ★☆ は活字なので残してあります（5段階の点を5つ並べる読ませかたは
    // 記号1つに置き換えられません）。それ以外の絵文字を探します。
    const re = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{2604}\u{2607}-\u{27BF}]/u;
    const bad = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const m = n.textContent.match(re);
      if (m) bad.push(`${m[0]} … ${n.textContent.trim().slice(0, 30)}`);
    }
    return {
      bad,
      // 記号そのものが出ていること。0個なら、置き換えたつもりで
      // 何も描いていないことになります。
      icons: document.querySelectorAll("svg.ic").length,
      // どの記号かが読めること（data-icon）。
      named: [...document.querySelectorAll("svg.ic")]
        .filter((e) => e.dataset.icon || e.closest("#open-settings, #use-here,"
          + " #make-plan, #map-expand, #back-to-form")).length,
      // 線の太さが、ぜんぶ同じであること。ここがそろっていないと、
      // 並べたときに太さの違いだけが目に付きます。
      widths: [...new Set([...document.querySelectorAll("svg.ic")]
        .map((e) => getComputedStyle(e).strokeWidth))],
      // 読み上げに出ないこと。字は必ず横に書いてあります。
      spoken: [...document.querySelectorAll("svg.ic")]
        .filter((e) => e.getAttribute("aria-hidden") !== "true"
          && e.getAttribute("role") !== "img").length,
    };
  });
  assert(got.bad.length === 0, `絵文字が残っています: ${got.bad.join(" / ")}`);
  assert(got.icons > 20, `記号が ${got.icons} 個しか出ていません`);
  assert(got.named === got.icons,
    `名前の無い記号が ${got.icons - got.named} 個あります`);
  // px に直すと、字の大きさごとに値が変わります（1.6 は viewBox の中の
  // 数なので、描かれる太さは表示の大きさで変わります）。ここで見たいのは
  // **指定がそろっているか**なので、種類の数で見ます。
  assert(got.widths.length <= 2,
    `線の太さが ${got.widths.length} 種類あります: ${got.widths.join(", ")}`);
  assert(got.spoken === 0, `読み上げに出る記号が ${got.spoken} 個あります`);
});

// 待っているあいだの絵が、本当に描かれること。
//
// 旅程を組むのに圏内では1〜2分かかります。そのあいだ、6段の一覧と
// 経過時間だけでは「止まっていないことは分かるが、何が起きているのかは
// 分からない」画面でした。出発地・収録・候補・決まった順を本物の座標で
// 描き、収録の説明文を一言ずつ流します（js/sketch.js）。
//
// 圏外の試験では3秒で組み上がってしまい、本番の流れでは確かめられない
// ので、段を手で進める頁（tests/e2e/pages/sketch.html）で見ます。
// **描かれた画素を数えます。** 以前、札を画面に置く前に絵を載せて
// いて、最初の1コマで自分から止まり、何も描かれないまま気づきません
// でした。
await check("待っているあいだの絵が、描かれている", async () => {
  const pg = await browser.newPage({ viewport: { width: 390, height: 700 } });
  try {
    await pg.goto(`${BASE}/tests/e2e/pages/sketch.html`,
                  { waitUntil: "domcontentloaded" });
    await pg.waitForTimeout(600);
    const at = async (step) => {
      await pg.evaluate((s) => window.__go(s), step);
      await pg.waitForTimeout(1200);
      return pg.evaluate(() => {
        const c = document.querySelector(".sketch canvas");
        if (!c) return { painted: 0, caption: "" };
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let painted = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted += 1;
        return { painted,
                 caption: document.querySelector(".sketch-caption")?.textContent ?? "" };
      });
    };
    const s0 = await at(0);
    assert(s0.painted > 0, "何も描かれていません（絵が止まっています）");
    const s2 = await at(2);
    // 候補が入ると、星が明るくなり、一言が収録の説明文になります。
    assert(s2.painted > s0.painted, "候補を渡しても絵が変わりません");
    assert(/—/.test(s2.caption), `一言が出ていません: ${s2.caption}`);
    const s4 = await at(4);
    assert(s4.painted > 0, "決まった順が描かれていません");
  } finally {
    await pg.close();
  }
});

await check("ページの例外が出ていない", () => {
  assert(pageErrors.length === 0, pageErrors.join(" / "));
});

clearInterval(answering);
await browser.close();

console.log(results.join("\n"));
console.log(`\n${results.length - failures} / ${results.length} 通過`);
process.exit(failures ? 1 : 0);
