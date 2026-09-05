// 画面まわり。旅程を組む流れそのものは pipeline.js にあります。
//
// ここでやること:
//   ・入力を読んで旅の条件（trip）にする
//   ・pipeline.js を呼ぶ
//   ・結果を描く／エラーを日本語で出す
//   ・APIキーの疎通確認（「キーを入れたのに効かない」を切り分けるため）

import { GEMINI_API_KEY, KB_INDEX_URL, MAPS_API_KEY, PROXY_URL,
         TILE_ATTRIBUTION, TILE_URL }
  from "./config.js";
import { callModel, describeSpot, diagnoseGeminiKey, hasApiKey }
  from "./ai.js";
import { discoverArea } from "./discover.js";
import { loadKnowledgeBase, mergeIntoKb } from "./kb.js";

import { diagnoseMapsKey, resetRoutesBreaker, routesUsage } from "./routes.js";
import { PLACES, findPlace, nearestPlaceInfo } from "./places.js";
import { END_MODES, makeTrip, validateTrip } from "./trip.js";
import { TripMap, pointsFromItinerary } from "./map.js";
import { planTrip } from "./pipeline.js";
import { haversineKm } from "./feasibility.js";
import { configureQuota, describeUsage, quota } from "./quota.js";
import { artFor, moodArt } from "./art.js";
import { photoFor } from "./photos.js";
import { applyEdit, describeEdit, parseEdit } from "./edit.js";
import { applyReplan } from "./replan.js";
import { confidenceOf, describeSource, freshnessOf } from "./confidence.js";
import { userFacing } from "./errors.js";
import { spotFit, tripFit } from "./fit.js";
import { paceBreakdown, slackLevel } from "./score.js";
import { VARIANTS, distinguishOf, recommendOf, summaryOf, tripsFor }
  from "./variants.js";
import { $, el, openSheet, renderItinerary, renderProgress, renderToday,
         suggestionButton } from "./ui.js";
import { catchUp } from "./today.js";
import { addHistory, clearHistory, loadHistory, removeHistory, savedLabel }
  from "./history.js";

const state = { kb: null, map: null, bgMap: null, homeMap: null, trip: null,
                endMode: "origin", mode: "plan",
                discovering: false, aiSpots: 0,
                // ペースは、利用者が「もっとゆっくり」等を押したときだけ
                // 指定します。既定では希望文からの読み取りに任せます。
                pace: null, clearArea: false, avoidIds: [], editNote: "",
                // 3案とおすすめ。案を選び直すときに使い回します。
                plans: [], recommendKey: "", recommendWhy: "",
                chosenTrip: null,
                // 旅行中モードで「着いた」を押した予定
                arrivedAtId: "",
                pinned: new Map() };

// --- 起動 -------------------------------------------------------------------

async function boot() {
  state.map = new TripMap("map");
  state.map.configure({ tileUrl: TILE_URL, attribution: TILE_ATTRIBUTION });
  startBackgroundMap();
  startHomeMap();

  configureQuota({ ask: askQuota, onChange: showQuota });

  registerServiceWorker();
  renderRecent();

  fillPlaces();
  setDefaultDates();
  fillMoodRail();
  wireForm();
  wireKeyPanel();
  wireChrome();
  updateWindowHelp();

  // 知識ベースは 3MB あります。読み終わる前に押されると、これまでは
  // 「データを読み込めていません」で行き止まりでした。押せなくしておいて、
  // 読み終わったら自分で押せるようになるほうが、待つ理由が分かります。
  const fab = $("#make-plan");
  fab.disabled = true;
  fab.querySelector(".fab-tx").textContent = "旅先のデータを読んでいます…";

  try {
    state.kb = await loadKnowledgeBase();
    if (state.kb.loadError) setBadge(state.kb.loadError, true);
    const restored = restoreConditions();
    if (restored === "url") {
      $("#ph-data").textContent = "共有されたリンクの条件を読み込みました。";
    }
    // 使う人には件数を、開発者には出どころを。
    const c0 = state.kb.manifest.counts;
    $("#key-kb").textContent =
      `全国${c0.regions}エリア・${c0.spots}スポット`;
    const devKb = $("#dev-kb");
    if (devKb) {
      devKb.textContent = KB_INDEX_URL
        ? `公開知識ベース（${KB_INDEX_URL}）` : "同梱データ（KB_INDEX_URL 未設定）";
    }
    renderAttribution(state.kb);
    const c = state.kb.manifest.counts;
    $("#ph-data").textContent =
      `確認済みの収録は全国${c.regions}エリア・${c.spots}スポット。`
      + (hasApiKey()
        ? "ここに無い土地（海外も含む）は、AIが検索して調べます。"
        : "AIキーが未設定のため、いまは収録されている範囲からのみ提案します"
          + "（js/config.js にキーを入れると、海外や収録に無い土地も"
          + "調べられるようになります）。");
  } catch (e) {
    setBadge(`データを読み込めません: ${e.message}`, true);
    $("#ph-data").textContent =
      "知識ベースを読み込めませんでした。web/ をサーバ経由で開いているか、"
      + "kb/ フォルダが同じ場所にあるかをご確認ください。";
  } finally {
    // 読めなかった場合も押せる状態に戻します。押せば理由が出ます。
    // 押せないまま理由も出ないのが、いちばん困ります。
    fab.disabled = false;
    fab.querySelector(".fab-tx").textContent = "旅程をつくる";
  }
}

/**
 * 電波の無いところでも、作った旅程を開けるようにします。
 *
 * 旅程がいちばん要るのは、家で作っているときではなく **現地** です。
 * 山の中でも地下でも、少なくとも画面と収録データは出てほしい。
 *
 * 失敗しても黙って進みます。Service Worker が使えないのは
 * http:// で開いた場合などで、そのときも旅程は普通に作れます。
 */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !isSecureContext) return;
  // 起動を待たせません。読み込みが終わってから登録します。
  addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* 使えない環境では、ただ手前の機能が無いだけです */
    });
  });
}

// --- 前につくった旅 ---------------------------------------------------------

/**
 * 一覧を描きます。
 *
 * 覚えているのは条件だけなので、押されたら入力欄に戻して組み直します
 * （js/history.js に理由を書いています）。旅程そのものを保存して
 * そのまま出すと、営業時間の変わった店へ案内することになります。
 */
function renderRecent() {
  const box = $("#recent");
  const list = $("#recent-list");
  if (!box || !list) return;

  const items = loadHistory();
  box.hidden = items.length === 0;
  list.replaceChildren();

  for (const item of items) {
    const row = el("button", {
      type: "button", class: "recent-row",
      title: "この条件でもう一度つくる",
      onclick: () => replayHistory(item),
    },
      el("span", { class: "r-body" },
        el("span", { class: "r-title" }, item.title),
        el("span", { class: "r-sub" }, item.subtitle || item.when || "")),
      el("span", { class: "r-when" }, savedLabel(item.savedAt)));

    const del = el("button", {
      type: "button", class: "recent-del",
      "aria-label": `${item.title} を一覧から消す`,
      onclick: () => { removeHistory(item.id); renderRecent(); },
    }, "\u2715");

    list.append(el("li", { class: "recent-item" }, row, del));
  }
}

/** 一覧の1件を押したとき。条件を入力欄に戻して、そのまま組み直します。 */
function replayHistory(item) {
  applyFormState(item.state);
  // 日付だけは、そのままだと過去になっていることがあります。
  // 過ぎた日で組むと「出発時刻が過去です」で止まるので、
  // そのときは同じ長さのまま、次の同じ曜日へずらします。
  shiftPastDates();
  saveConditions();
  run();
}

/**
 * 出発日が過去なら、日数と時刻を保ったまま先の日へずらします。
 * 曜日を合わせるのは、休館日と混雑が曜日で決まるためです。
 */
function shiftPastDates() {
  const dep = $("#depart-at"), arr = $("#arrive-by");
  const d0 = new Date(dep.value), d1 = new Date(arr.value);
  if (!Number.isFinite(d0.getTime()) || d0 > new Date()) return;
  const weeks = Math.ceil((Date.now() - d0.getTime()) / (7 * 86400000));
  const shift = weeks * 7 * 86400000;
  dep.value = localInput(new Date(d0.getTime() + shift));
  if (Number.isFinite(d1.getTime())) {
    arr.value = localInput(new Date(d1.getTime() + shift));
  }
  updateWindowHelp();
}

/** <input type="datetime-local"> が読める形。UTC にはしません。 */
function localInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
       + `T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** つくれた旅程を、一覧に1件足します。 */
function rememberTrip(itin, trip) {
  const days = itin.days?.length ?? 0;
  const d = trip.departAt;
  addHistory({
    title: itin.title ?? itin.regionName ?? "旅程",
    subtitle: [itin.prefecture, `${itin.spotCount ?? 0}か所`]
      .filter(Boolean).join("・"),
    when: `${d.getMonth() + 1}/${d.getDate()}から${days}日`,
    state: formState(),
  });
  renderRecent();
}

/**
 * データの出どころを画面に出します。
 * 国土数値情報は出典の表示が条件になっているので、消さないでください。
 */
function renderAttribution(kb) {
  const box = $("#attribution");
  if (!box) return;
  const list = kb.attribution ?? [];
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  box.textContent = "";
  box.append(el("span", {}, "データ: "));
  list.forEach((s, i) => {
    if (i) box.append(el("span", {}, " / "));
    box.append(s.url
      ? el("a", { href: s.url, target: "_blank", rel: "noreferrer" }, s.name)
      : el("span", {}, s.name));
  });
}

function setBadge(text, isError = false) {
  const b = $("#kb-status");
  b.textContent = text;
  b.classList.toggle("err", isError);
}

function fillPlaces() {
  const list = $("#place-list");
  for (const p of PLACES) {
    list.append(el("option", { value: p.name }, `${p.area}`));
  }
  $("#depart-place").value = "東京駅";
}

function setDefaultDates() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  const iso = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      + `T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const dep = new Date(t); dep.setHours(9, 0, 0, 0);
  const ret = new Date(t); ret.setHours(19, 0, 0, 0);
  $("#depart-at").value = iso(dep);
  $("#arrive-by").value = iso(ret);
}

function wireKeyPanel() {
  const mark = (elm, ok, text) => {
    elm.textContent = text;
    elm.classList.toggle("ok", ok);
    elm.classList.toggle("ng", !ok);
  };
  // 使う人に向けては、「できるかどうか」だけを言います。
  //
  // 「Gemini」「Routes API」は、こちらの都合の名前です。使う人が
  // 知りたいのは「AIが効いているのか」だけです。キーの末尾も出しません。
  // 見せても何もできませんし、キーというものがあることを意識させる
  // 必要もありません。
  // プロキシを使っているなら、キーはサーバー側にあります。
  // ブラウザ側が空なのは正常なので、「未設定」とは言いません。
  const viaProxy = Boolean(String(PROXY_URL ?? "").trim());
  const aiOn = hasApiKey();
  const routesOn = viaProxy || Boolean(MAPS_API_KEY);
  mark($("#key-gemini"), aiOn,
       aiOn ? "利用できます" : "使わない設定です（収録データから提案します）");
  mark($("#key-maps"), routesOn,
       routesOn ? "利用できます" : "使わない設定です（距離から推定します）");

  // 開発者向けには、設定されているかどうかまで出します。
  // ここでも末尾は出しません。分かって困ることはあっても、得はありません。
  const dev = (id, ok) => {
    const elm = $(id);
    if (elm) mark(elm, ok, ok ? "設定済み" : "未設定");
  };
  dev("#dev-gemini", Boolean(GEMINI_API_KEY) || viaProxy);
  dev("#dev-maps", Boolean(MAPS_API_KEY) || viaProxy);

  const run = async (btn, fn) => {
    const out = $("#key-result");
    btn.disabled = true;
    out.textContent = "確認しています…";
    out.classList.remove("ok", "ng");
    try {
      const r = await fn();
      out.textContent = r.message;
      out.classList.toggle("ok", r.ok);
      out.classList.toggle("ng", !r.ok);
    } catch (e) {
      out.textContent = String(e?.message ?? e);
      out.classList.add("ng");
    } finally {
      btn.disabled = false;
    }
  };
  $("#test-gemini").addEventListener("click", (e) =>
    run(e.currentTarget, () => diagnoseGeminiKey()));
  $("#test-maps").addEventListener("click", (e) =>
    run(e.currentTarget, () => diagnoseMapsKey()));

  $("#reset-quota").addEventListener("click", () => {
    quota.reset();
    showQuota();
  });
  showQuota();
}

// --- APIの使用量 ------------------------------------------------------------
// 50件ごとに手を止めて確認します。「気づいたら請求が膨らんでいた」を
// 起こさないための仕組みなので、確認は必ず画面の中央で行い、
// 返事をもらうまで先へ進みません。

function showQuota() {
  const box = $("#key-quota");
  if (!box) return;
  // 一覧の行に長い文を入れると、左の項目名と重なります。
  // ここは件数だけ。詳しい内訳は、確認ダイアログのほうで出します。
  box.textContent = quota.blocked
    ? `${quota.used}件で停止中`
    : `${quota.used}件（あと${quota.remaining}件で確認）`;
  box.title = describeUsage(quota);
  box.classList.toggle("ng", quota.blocked);
  box.classList.remove("ok");
}

/** 確認ダイアログ。押されたボタンだけが返事になります。 */
function askQuota({ used, byKind, next }) {
  const dlg = $("#quota-dialog");
  // 内訳も、旅行者に意味の通る言葉にします。
  // 「embed 12件」と書かれても、何のことか分かりません。
  const label = { routes: "乗換・所要時間の確認", gemini: "行き先の調査",
                  embed: "希望の読み取り" };
  const parts = Object.entries(byKind).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${label[k] ?? k} ${n}回`);
  $("#quota-detail").textContent =
    `ここまでに ${used}回 調べました`
    + (parts.length ? `（内訳: ${parts.join("・")}）` : "")
    + "。";
  $("#quota-go").querySelector("span").textContent = "詳しく調べる";

  return new Promise((resolve) => {
    const done = (ok) => {
      $("#quota-go").removeEventListener("click", yes);
      $("#quota-stop").removeEventListener("click", no);
      dlg.close();
      resolve(ok);
    };
    const yes = () => done(true);
    const no = () => done(false);
    $("#quota-go").addEventListener("click", yes);
    $("#quota-stop").addEventListener("click", no);
    // Esc で閉じられると、続けたいのか止めたいのかが分かりません
    dlg.addEventListener("cancel", (e) => e.preventDefault());
    dlg.showModal();
  });
}


// --- 画面まわりの部品 -------------------------------------------------------

/**
 * 背景の地図。入力しているあいだも、地図はそこにあります。
 *
 * 真っ白な入力画面より、「これから出かける」という気配が残ります。
 * 触れませんし、ピンも線も出しません。読むものではないからです。
 * オフラインでもキャッシュ済みのタイルがぼやけて残ります。
 */
function startBackgroundMap() {
  const box = $("#bg-map");
  if (!box || !window.L) return;
  try {
    const map = window.L.map(box, {
      zoomControl: false, attributionControl: false,
      dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
      boxZoom: false, keyboard: false, touchZoom: false,
      // 背景なので、読み上げにも操作にも載せません
      inertia: false,
    }).setView([35.68, 139.76], 9);
    window.L.tileLayer(TILE_URL, { maxZoom: 19 }).addTo(map);
    state.bgMap = map;
  } catch {
    // 地図が出せなくても、入力画面は成立します
  }
}

/**
 * まだ旅程が無いときに出す地図。いまいるあたりを映します。
 *
 * 「行き先が決まっていなくても大丈夫です」と文字で言うより、
 * 地図が出ているほうが、これから出かける気配が伝わります。
 *
 * ページを開いた時点では、位置情報を要求しません。
 * 何も操作していない相手にいきなり「現在地を使用しますか？」を出すのは、
 * 何のために聞かれているのか分からないぶん、断られて当然です。
 * 「現在地から探す」を押されたときだけ取りにいきます（locateHere）。
 */
/**
 * 地図の部品が届くのを待ちます。
 *
 * 読み込みは async にしてあります（ページ全体を止めないため）。
 * そのぶん、app.js が動き出した時点では、まだ届いていないことがあります。
 * 待つのはここだけです。条件の入力も旅程づくりも、地図を待ちません。
 *
 * @param {number} timeoutMs これを過ぎたら、地図なしで進みます
 */
function whenLeaflet(timeoutMs = 8000) {
  if (window.L) return Promise.resolve(true);
  return new Promise((resolve) => {
    const limit = Date.now() + timeoutMs;
    const tick = () => {
      if (window.L) return resolve(true);
      if (Date.now() > limit) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function startHomeMap() {
  const box = document.getElementById("home-map");
  if (!box) return;
  await whenLeaflet();
  if (!window.L) {
    // 地図を読み込めない環境で、灰色の四角を黙って出さないこと。
    // 旅程づくりは地図が無くても成立します。
    box.classList.add("map-fallback");
    box.textContent = "地図を読み込めませんでした"
      + "（インターネット接続をご確認ください）。"
      + "旅程はこのままつくれます。";
    return;
  }
  try {
    const map = window.L.map(box, {
      zoomControl: true, scrollWheelZoom: false,
      attributionControl: true,
    }).setView([36.2, 138.3], 5);
    window.L.tileLayer(TILE_URL,
      { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);
    state.homeMap = map;
  } catch {
    return;   // 地図が出せなくても、入力はできます
  }

}

/**
 * 「現在地から探す」を押されたときだけ、位置情報を取りにいきます。
 *
 * 取れたら、いちばん近い出発地の候補を入れます。緯度経度をそのまま
 * 出発地にはしません。経路検索は駅を起点にするほうが実態に合いますし、
 * 利用者から見ても「新宿駅から」のほうが確かめようがあります。
 *
 * 位置を送る先はありません。この関数の中だけで使います。
 */
function locateHere() {
  const btn = document.getElementById("use-here");
  // 知らせる場所は、押したボタンのすぐ下です。
  // 以前は初期画面の地図の下に出していたので、旅程を作ったあとは
  // 画面から消えていて、押しても何も起きないように見えていました。
  const note = document.getElementById("here-note");
  const say = (text, warn = false) => {
    if (!note) return;
    note.textContent = text;
    note.classList.toggle("warn", warn);
  };
  const reset = () => {
    if (!btn) return;
    btn.disabled = false;
    btn.querySelector("span:last-child").textContent = "現在地から探す";
  };

  if (!navigator.geolocation) {
    say("この環境では現在地を取得できません。出発地は駅名で入力してください。", true);
    return;
  }
  // https でないページでは、ブラウザが**聞かずに断ります**。
  // 利用者は何も押していないのに「許可されていません」と出るので、
  // 自分が拒否したのだと思ってしまいます。理由が違うので、先に分けます。
  if (!window.isSecureContext) {
    say("このページは暗号化されていない接続（http）で開かれているため、"
      + "ブラウザが現在地の利用を許しません。https で開くか、"
      + "出発地を駅名で入力してください。", true);
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.querySelector("span:last-child").textContent = "探しています…";
  }
  say("現在地を確かめています…");

  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude: lat, longitude: lng } = pos.coords;
    const found = nearestPlaceInfo(lat, lng);
    const near = found?.place ?? null;
    if (near) {
      $("#depart-place").value = near.name;
      saveConditions();
      // 「東京駅に19:00までに戻る」の文も書き換えます。
      // これを呼んでいなかったので、出発地を入れ替えても画面の文が
      // 前のままでした。**押しても反映されない**、に見えます。
      updateWindowHelp();
    }
    try {
      state.homeMap?.setView([lat, lng], 11, { animate: true });
      window.L?.circleMarker([lat, lng], {
        radius: 8, color: "#007AFF", fillColor: "#007AFF", fillOpacity: .85,
        weight: 3, opacity: .35,
      }).addTo(state.homeMap);
      moveBackgroundMap(lat, lng, 10);
    } catch { /* 地図の演出です。失敗しても続けます */ }
    reset();
    // どれくらい近いのかで、言うべきことが変わります。
    // 100km 先の駅を「いちばん近い駅」とだけ書いて入れると、
    // 現在地を取ったのに、まったく違う土地から旅程が組まれます。
    const FAR_KM = 30;
    if (!near) {
      say("現在地は分かりましたが、近くに収録している駅がありませんでした。"
        + "出発地は駅名で入力してください。", true);
    } else if (found.km > FAR_KM) {
      say(`いちばん近い収録の駅は「${near.name}」で、現在地から約${found.km}km`
        + "あります。ここを出発地にしましたが、"
        + "もっと近い駅があれば直接入力してください。", true);
    } else {
      say(`出発地を「${near.name}」にしました`
        + `（現在地から約${Math.max(1, found.km)}km、いちばん近い駅）。`);
    }
  }, (err) => {
    reset();
    // 何が起きたかで、次にすることが変わります。
    //
    //   1 PERMISSION_DENIED    … 断られた（本人が断ったとは限りません）
    //   2 POSITION_UNAVAILABLE … 測れなかった（屋内・機内モードなど）
    //   3 TIMEOUT              … 時間切れ
    //
    // 1 を「あなたが断りました」と書くのは誤りです。組織の設定や
    // 拡張機能、端末側の設定でも 1 になります。**押していないのに
    // 「許可されていません」と出る**のはこれでした。
    const msg = {
      1: "このブラウザでは現在地を使えませんでした"
        + "（設定・拡張機能・端末側で止められていることがあります）。"
        + "出発地は駅名で入力してください。",
      2: "現在地を測れませんでした（屋内や電波の届かない場所で起きます）。"
        + "出発地は駅名で入力してください。",
      3: "現在地の取得に時間がかかりすぎました。"
        + "もう一度押すか、出発地を駅名で入力してください。",
    }[err?.code] ?? "現在地を取得できませんでした。"
      + "出発地は駅名で入力してください。";
    say(msg, true);
  }, { timeout: 8000, maximumAge: 600000 });
}

/** 背景の地図を、いま見ている場所へ寄せます。 */
function moveBackgroundMap(lat, lng, zoom = 10) {
  if (!state.bgMap || !Number.isFinite(lat)) return;
  try { state.bgMap.setView([lat, lng], zoom, { animate: true }); }
  catch { /* 背景の演出なので、失敗しても黙って続けます */ }
}

// --- 雰囲気チップ -----------------------------------------------------------
// 文字だけのボタンを並べると、どれも同じに見えて読み飛ばされます。
// 色の面をつけると、読む前に「温泉っぽい」「海っぽい」で選べます。

// 旅の入口に並べるもの。**6枚まで**にしています。
//
// 9枚あったときは、選ぶ前にスクロールが要りました。入口で迷わせては
// 意味がありません。「富士山に登りたい」「オーロラが見たい」のような
// 行き先の名指しは、カードではなく自由入力の例に回しました
// （選択肢としてではなく、「こういうことも書ける」の見本として）。
const MOODS = [
  "温泉でゆっくり癒されたい",
  "歴史ある街を歩いて、美味しいものを食べたい",
  "人が少ない静かな場所で自然を感じたい",
  "絶景が見たい。写真をたくさん撮りたい",
  "海の見えるところでのんびりしたい",
  "美術館と建築をめぐりたい",
];

/** 自由入力の見本。カードでは表せない「名指し」を見せます。 */
const FREE_EXAMPLES = [
  "北海道で鉄道に乗りながら、有名な自然を見たい",
  "富士山に登りたい",
  "パリで美術館をめぐりたい",
  "オーロラが見たい",
];

const MOOD_LABEL = {
  "温泉でゆっくり癒されたい": "温泉でゆっくり",
  "歴史ある街を歩いて、美味しいものを食べたい": "歴史ある街歩き",
  "人が少ない静かな場所で自然を感じたい": "静かな自然",
  "絶景が見たい。写真をたくさん撮りたい": "絶景・写真",
  "海の見えるところでのんびりしたい": "海でのんびり",
  "美術館と建築をめぐりたい": "アートと建築",
};

function moodChip(label, full, onPick) {
  const art = moodArt(full);
  const btn = el("button", { type: "button", class: "mood",
                             "aria-pressed": "false",
                             style: `background-image:${art.css}` });
  btn.append(
    el("span", { class: "m-ic", "aria-hidden": "true" }, art.icon),
    el("span", { class: "m-tx" }, label));
  btn.addEventListener("click", () => onPick(full, btn));
  return btn;
}

function fillMoodRail() {
  const rail = $("#mood-rail");
  if (!rail) return;
  for (const m of MOODS) {
    rail.append(moodChip(MOOD_LABEL[m] ?? m, m, (text, btn) => {
      // 押したら、その希望文をそのまま条件にします。
      // 自由入力の欄は畳んだままで構いません。開かなくても
      // 「これを選んだ」と分かるように、カード側に印を付けます。
      $("#note").value = text;
      saveConditions();
      for (const other of rail.querySelectorAll(".mood")) {
        other.classList.toggle("is-selected", other === btn);
        other.setAttribute("aria-pressed", String(other === btn));
      }
    }));
  }
  // 自由入力の見本。カードでは表せない「名指し」を並べます。
  const box = document.getElementById("free-examples");
  if (box) {
    for (const text of FREE_EXAMPLES) {
      const b = el("button", { type: "button", class: "ex-chip" }, text);
      b.addEventListener("click", () => {
        $("#note").value = text;
        $("#note").dispatchEvent(new Event("input"));
        $("#note").focus();
        saveConditions();
      });
      box.append(b);
    }
  }

  // 自由入力を触ったら、カードの印は外します。
  // 選んだ文と、書いてある文が違う状態を残さないためです。
  $("#note")?.addEventListener("input", () => {
    for (const other of rail.querySelectorAll(".mood")) {
      other.classList.remove("is-selected");
      other.setAttribute("aria-pressed", "false");
    }
  });
}

// --- 穴場の度合いを、星の粒で見せる -----------------------------------------
// 「40%」と書かれても、それがどれくらいかは伝わりません。
// 粒が増えるのが見えれば、動かしながら決められます。

function renderStardust(value) {
  const box = $("#stardust");
  if (!box) return;
  const n = Math.round(4 + (value / 100) * 46);

  // 毎回作り直すと、粒に付いた出現アニメーションが動かすたびに
  // 頭から始まり、掴んで動かしているあいだ点が消えたままになります。
  // 足りないぶんだけ足し、多いぶんだけ外します。
  const have = box.children.length;
  for (let i = have; i < n; i++) {
    // 位置と大きさは番号から決めます。動かすたびに散らばりが
    // 変わると、増えたのか減ったのかが分からなくなります。
    const x = ((i * 37) % 100);
    const y = ((i * 61) % 100);
    const size = 1.5 + ((i * 13) % 5) * 0.6;
    box.append(el("i", { style: `left:${x}%;top:${y}%;`
      + `width:${size}px;height:${size}px` }));
  }
  for (let i = have; i > n; i--) box.lastElementChild?.remove();

  // 星の粒だけでは、どちらへ寄っているのかが分かりませんでした
  // （増えているのは分かるが、それが「定番」なのか「穴場」なのか）。
  // 10か所行くとしたら何対何になるのか、数で先に言います。
  const hidden = Math.round(value / 10);
  const classic = 10 - hidden;
  const set = (id, text) => { const e = $(id); if (e) e.textContent = text; };
  set("#mix-classic-n", String(classic));
  set("#mix-hidden-n", String(hidden));
  // 帯の左は「定番」です。value は穴場寄りの度合いなので、
  // そのまま幅にすると、定番2割のときに藍が8割になります
  // （数字と絵が逆を向いていました）。
  const fill = $("#mix-fill");
  if (fill) fill.style.width = `${100 - value}%`;
  const view = $("#mix-view");
  if (view) {
    view.classList.toggle("to-hidden", value > 55);
    view.classList.toggle("to-classic", value < 45);
  }

  const help = $("#hidden-bias-help");
  if (help) {
    help.textContent = value <= 20 ? "誰でも知っている場所を中心に組みます"
      : value <= 45 ? "定番を軸に、穴場を少し混ぜます"
      : value <= 75 ? "定番と穴場を半分ずつ混ぜます"
      : "知る人ぞ知る場所を多めにします";
  }
}

/**
 * 1日に動ける時間。
 *
 * 帰着時刻とは別のことです。3泊4日で「毎日9時間歩ける」人と
 * 「6時間で切り上げたい」人では、入る件数がまるで変わります。
 * 時計の絵で、その長さを見せます。
 */
function renderDayHours(hours) {
  const dial = $("#day-dial");
  if (dial) {
    // 円弧で長さを見せます。数字だけだと、9時間が長いのか短いのか
    // 判断できません。1日の中でどれだけ使うのかを面積で出します。
    const share = Math.max(0, Math.min(1, hours / 16));
    dial.style.setProperty("--share", String(share));
    dial.textContent = "";
    const label = el("b", {}, `${hours}時間`);
    dial.append(label);
  }
  const help = $("#day-hours-help");
  if (help) {
    help.textContent = hours <= 6 ? "朝はゆっくり、夕方には宿へ戻ります"
      : hours <= 9 ? "ふつうに歩ける長さです"
        : hours <= 12 ? "朝から夜まで、しっかり動きます"
          : "かなり長い一日です。連日だと疲れが残ります";
  }
}

// --- 画面の共通部品 ---------------------------------------------------------

function wireChrome() {
  // 前につくった旅を、まとめて消す。
  // 端末に残るものなので、消す手段は必ず画面から届くところに置きます。
  $("#recent-clear")?.addEventListener("click", () => {
    clearHistory();
    renderRecent();
  });

  // 設定。ふだんは見えなくてよいものを、ここにまとめます。
  // 配色に切り替えは置きません。端末の設定（ダークモード）に合わせます。
  const settings = $("#settings-dialog");
  $("#open-settings")?.addEventListener("click", () => {
    showQuota();
    showRoutesUsage();
    settings?.showModal();
  });
  $("#settings-close")?.addEventListener("click", () => settings?.close());
  settings?.addEventListener("click", (e) => {
    if (e.target === settings) settings.close();
  });

  // 地図を大きく見る。旅程は下に残したままにします
  // （地図だけになると「どこの話か」を見失うためです）
  $("#map-expand")?.addEventListener("click", () => {
    const box = $("#result");
    box.classList.toggle("map-full");
    setTimeout(() => state.map.invalidate(), 340);
  });

  const bias = $("#hidden-bias");
  if (bias) {
    renderStardust(Number(bias.value));
    bias.addEventListener("input", () => renderStardust(Number(bias.value)));
    bias.addEventListener("change", saveConditions);
  }

  const dayHours = $("#day-hours");
  if (dayHours) {
    renderDayHours(Number(dayHours.value));
    dayHours.addEventListener("input",
      () => renderDayHours(Number(dayHours.value)));
    dayHours.addEventListener("change", () => {
      saveConditions();
      updateWindowHelp();
    });
  }
}

function togglePin(spot) {
  if (state.pinned.has(spot.id)) state.pinned.delete(spot.id);
  else state.pinned.set(spot.id, spot);
  renderPinned();
}

/** 「必ず行く」に入れた場所を、旅程の条件側に出しておきます。 */
function renderPinned() {
  const box = $("#pinned");
  box.textContent = "";
  box.hidden = state.pinned.size === 0;
  if (!state.pinned.size) return;
  box.append(el("label", {}, "必ず行く場所（絶対条件）"));
  const list = el("div", { class: "pin-list" });
  for (const spot of state.pinned.values()) {
    const chip = el("span", { class: "pin-chip" }, `${spot.name}`);
    chip.append(el("button", {
      type: "button", title: "外す",
      onClick: () => { state.pinned.delete(spot.id); renderPinned(); },
    }, "×"));
    list.append(chip);
  }
  box.append(list);
  box.append(el("p", { class: "help" },
    "ここに入れた場所は、時間が足りなくても旅程から削られません。"
    + "入れられなかった場合は理由を表示します。"));
}

function wireForm() {
  for (const btn of document.querySelectorAll("#end-choice button")) {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#end-choice button")
        .forEach((b) => b.classList.toggle("is-selected", b === btn));
      state.endMode = btn.dataset.end;
      const other = state.endMode === "other";
      $("#end-place-field").hidden = !other;
      $("#end-help").textContent = other
        ? "行きと帰りで場所が違う旅（片道・乗り継ぎ）もこれで組めます。"
        : "旅を終えたときに、出発した駅へ戻る前提で組みます。";
      updateWindowHelp();
    });
  }
  for (const btn of document.querySelectorAll("[data-example]")) {
    btn.addEventListener("click", () => { $("#note").value = btn.dataset.example; });
  }
  for (const chip of document.querySelectorAll(".md-chip[data-genre]")) {
    chip.addEventListener("click", () => {
      const on = chip.getAttribute("aria-pressed") !== "true";
      chip.setAttribute("aria-pressed", String(on));
      chip.classList.toggle("is-selected", on);
      saveConditions();
    });
  }
  $("#use-here").addEventListener("click", locateHere);
  $("#depart-at").addEventListener("change", updateWindowHelp);
  $("#depart-place").addEventListener("change", updateWindowHelp);
  $("#arrive-by").addEventListener("change", updateWindowHelp);
  // 引数なしで呼びます。そのまま渡すと、クリックイベントが
  // 「条件」として渡ってしまいます。
  $("#make-plan").addEventListener("click", () => run());
  $("#avoid-crowds").addEventListener("change", saveConditions);
  for (const id of ["#note", "#depart-place", "#end-place", "#depart-at",
                    "#arrive-by"]) {
    $(id).addEventListener("change", saveConditions);
  }
  $("#end-place").addEventListener("change", updateWindowHelp);
  // 入力中どこにいても Ctrl/⌘ + Enter で作成できるようにします
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (state.mode === "plan") run();
    }
  });
}

/**
 * 入力した時間の幅を、そのまま日本語の一文にします。
 *
 * 「帰着」という語だけでは、どこへ帰るのかが分かりません。
 * 「東京駅に19:00までに戻る」と書けば、読んだ瞬間に意味が通ります。
 */
function updateWindowHelp() {
  const dep = new Date($("#depart-at").value);
  const arr = new Date($("#arrive-by").value);
  const help = $("#window-help");
  const mins = Math.floor((arr - dep) / 60000);
  if (!Number.isFinite(mins) || mins <= 0) {
    help.textContent = "帰着は出発より後の時刻にしてください。";
    help.classList.add("warn");
    return;
  }
  if (mins < 150) {
    help.classList.add("warn");
    help.textContent = `旅程を組むにはあと${150 - mins}分ほど必要です。`;
    return;
  }
  help.classList.remove("warn");

  const nights = Math.max(0, Math.round(
    (new Date(arr).setHours(0, 0, 0, 0) - new Date(dep).setHours(0, 0, 0, 0))
    / 86400000));
  const span = nights === 0
    ? `日帰り・${Math.floor(mins / 60)}時間${mins % 60 ? `${mins % 60}分` : ""}`
    : `${nights}泊${nights + 1}日`;

  const hhmm = `${String(arr.getHours()).padStart(2, "0")}:`
    + String(arr.getMinutes()).padStart(2, "0");
  const back = state.endMode === "other"
    ? ($("#end-place").value.trim() || "終える場所")
    : ($("#depart-place").value.trim() || "出発地");
  const verb = state.endMode === "other" ? "着く" : "戻る";
  help.textContent = `${span}・${back}に${hhmm}までに${verb}`;
}

function readTrip() {
  const genres = [...document.querySelectorAll('.md-chip[aria-pressed="true"]')]
    .map((c) => c.dataset.genre);
  const other = state.endMode === "other";
  const end = other ? findPlace($("#end-place").value) : null;
  return makeTrip({
    origin: findPlace($("#depart-place").value),
    destination: end,
    returnTo: null,
    endMode: other ? END_MODES.END_AT_DESTINATION : END_MODES.RETURN_TO_ORIGIN,
    departAt: new Date($("#depart-at").value),
    arriveBy: new Date($("#arrive-by").value),
    note: $("#note").value,
    interests: genres,
    // 予算と穴場度は画面から外しました。予算はスポットの入場料程度しか
    // 効かず、実際の判断材料にならなかったためです。内部の既定値のみ使います。
    budgetYen: 999999,
    // 定番と穴場のまぜかた。画面では星の粒として出しています。
    hiddenBias: (Number($("#hidden-bias")?.value ?? 40)) / 100,
    // 1日に動ける時間。帰着時刻とは別のことです。
    dayHours: Number($("#day-hours")?.value ?? 9),
    ...(state.pace ? { pace: state.pace } : {}),
    avoidCrowds: $("#avoid-crowds").checked,
    must: {
      spotIds: [...state.pinned.keys()],
      // 「◯◯は外して」と言われた場所は、次からも出しません
      avoidSpotIds: state.avoidIds ?? [],
    },
  });
}

const SAVE_KEY = "tabisaki.lastTrip";

/** 入力欄の中身。保存・共有・復元で同じ形を使います。 */
function formState() {
  return {
    note: $("#note").value,
    from: $("#depart-place").value,
    to: $("#end-place").value,
    end: state.endMode,
    dep: $("#depart-at").value,
    arr: $("#arrive-by").value,
    genres: [...document.querySelectorAll('.md-chip[aria-pressed="true"]')]
      .map((c) => c.dataset.genre),
    crowd: $("#avoid-crowds").checked,
    bias: Number($("#hidden-bias")?.value ?? 40),
    hours: Number($("#day-hours")?.value ?? 9),
    pinned: [...state.pinned.keys()],
  };
}

function applyFormState(v) {
  if (!v) return;
  if (v.note) $("#note").value = v.note;
  if (v.from) $("#depart-place").value = v.from;
  if (v.to) $("#end-place").value = v.to;
  if (v.dep) $("#depart-at").value = v.dep;
  if (v.arr) $("#arrive-by").value = v.arr;
  if (typeof v.crowd === "boolean") $("#avoid-crowds").checked = v.crowd;
  if (Number.isFinite(v.bias) && $("#hidden-bias")) {
    $("#hidden-bias").value = String(v.bias);
    renderStardust(v.bias);
  }
  if (Number.isFinite(v.hours) && $("#day-hours")) {
    $("#day-hours").value = String(v.hours);
    renderDayHours(v.hours);
  }
  if (v.end === "other") {
    document.querySelector('[data-end="other"]')?.click();
  }
  for (const chip of document.querySelectorAll(".md-chip[data-genre]")) {
    const on = (v.genres ?? []).includes(chip.dataset.genre);
    chip.setAttribute("aria-pressed", String(on));
    chip.classList.toggle("is-selected", on);
  }
  for (const id of v.pinned ?? []) {
    const spot = state.kb?.spotsById?.get(id);
    if (spot) state.pinned.set(id, spot);
  }
  renderPinned();
  updateWindowHelp();
}

/** 条件を保存します（次に開いたときに、また入力し直さなくて済むように）。 */
function saveConditions() {
  try {
    globalThis.localStorage?.setItem(SAVE_KEY, JSON.stringify(formState()));
  } catch { /* 保存できなくても動作に影響はありません */ }
}

function restoreConditions() {
  // URL に条件が入っていればそれを優先（共有されたリンクを開いた場合）
  try {
    const q = new URLSearchParams(location.search).get("p");
    if (q) {
      applyFormState(JSON.parse(unpack(q)));
      return "url";
    }
  } catch { /* 壊れたリンクは無視して、保存済みに落ちます */ }
  try {
    const raw = globalThis.localStorage?.getItem(SAVE_KEY);
    if (raw) { applyFormState(JSON.parse(raw)); return "saved"; }
  } catch { /* 無ければ既定値のまま */ }
  return null;
}

/** いまの条件をURLにして、共有できるようにします。 */
/**
 * URL に載せられる形にします。
 *
 * 素の base64 には + と / が出てきます。+ はクエリ文字列では空白として
 * 解釈されるので、そのまま貼ると壊れたリンクになります（実際になりました）。
 * URL 安全な字だけを使う版に置き換えます。
 */
function pack(text) {
  return btoa(unescape(encodeURIComponent(text)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unpack(code) {
  const b64 = code.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(b64)));
}

async function shareConditions() {
  const packed = pack(JSON.stringify(formState()));
  const url = `${location.origin}${location.pathname}?p=${packed}`;
  try {
    await navigator.clipboard.writeText(url);
    setBadge("条件のリンクをコピーしました");
    setTimeout(() => setBadge(kbBadgeText()), 2600);
  } catch {
    // クリップボードが使えない環境では、URL を直接見せます
    globalThis.prompt?.("このURLを共有してください", url);
  }
}

function kbBadgeText() {
  if (!state.kb) return "";
  return `収録 ${state.kb.regions.length}エリア / ${state.kb.spots.length}スポット`
    + (state.aiSpots ? `（うちAI調べ ${state.aiSpots}件）` : "");
}

/** 経路APIを何回呼び、何が返ったかを、キーの欄に出します。 */
function showRoutesUsage() {
  const u = routesUsage();
  const box = $("#routes-usage");
  if (!box) return;
  if (!u.calls && !u.skipped) { box.textContent = ""; box.hidden = true; return; }
  box.hidden = false;
  const parts = [`直前の作成での呼び出し: ${u.calls}回`];
  if (u.failures) parts.push(`失敗 ${u.failures}回`);
  if (u.skipped) parts.push(`省略 ${u.skipped}回`);
  if (u.breakerOpen) parts.push("失敗が続いたため停止中");
  box.textContent = parts.join(" / ");
  box.classList.toggle("ng", Boolean(u.failures || u.breakerOpen));
  if (u.lastError) box.title = u.lastError;
  showQuota();
}

/**
 * うまくいかなかったことを伝えます。
 *
 * 「Routes API 403」のような技術用語は表に出しません。旅行者が
 * 知りたいのは「それで、旅程は作れるのか」の一点です。
 * 元のエラーは「技術的な詳細」を開いた人だけが見ます。
 */
function showError(text, suggestions = [], kind = "plan") {
  const box = $("#form-error");
  box.textContent = "";
  box.hidden = !text;
  if (!text) return;

  const m = userFacing(kind, text);
  const notice = el("div", { class: "notice notice--error" });
  notice.append(el("h3", {}, m.title === "うまくいきませんでした"
    ? "旅程を作れませんでした" : m.title));
  notice.append(el("p", {}, kind === "plan" ? String(text) : m.body));

  // 何が起きたかだけでは、読んだ人は止まります。次にできることを書きます。
  // 多くの場合、答えは「そのまま旅程は作れます」です。
  if (m.next && kind !== "plan") {
    notice.append(el("p", { class: "notice-next" }, m.next));
  }

  if (m.detail && kind !== "plan") {
    const det = el("details", {});
    det.append(el("summary", {}, "技術的な詳細"));
    det.append(el("pre", {}, [m.detail, m.hint].filter(Boolean).join("\n\n")));
    notice.append(det);
  }
  box.append(notice);

  if (suggestions.length) {
    // 「できません」で終わらせない。押せば条件を書き換えて組み直します。
    box.append(el("div", { class: "relax-list", style: "margin-top:12px" },
      suggestions.map((s) => suggestionButton(s, applySuggestion))));
  }
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/**
 * 旅程は作れたが、一部がうまくいかなかったことを伝えます。
 * 旅程の上に、控えめな箱として出します。
 */
function noticeFor(kind, raw) {
  const m = userFacing(kind, raw);
  const box = el("div", { class: "notice" });
  box.append(el("h3", {}, m.title), el("p", {}, m.body));
  if (m.detail) {
    const det = el("details", {});
    det.append(el("summary", {}, "技術的な詳細"));
    det.append(el("pre", {}, [m.detail, m.hint].filter(Boolean).join("\n\n")));
    box.append(det);
  }
  return box;
}

/**
 * 「もっとゆっくり」などの調整。
 *
 * 条件の画面まで戻らせると、そこで手が止まります。旅程のすぐ上に
 * 置いて、押したらそのまま組み直します。書き換えるのは条件だけで、
 * 組み立ては同じエンジンが行います（AIに旅程を作り直させません）。
 */
function adjustPlan(key) {
  const bias = $("#hidden-bias");
  const move = (delta) => {
    if (!bias) return;
    bias.value = String(Math.max(0, Math.min(100, Number(bias.value) + delta)));
    renderStardust(Number(bias.value));
  };
  if (key === "slower") state.pace = "relaxed";
  if (key === "fuller") state.pace = "packed";
  if (key === "hidden") move(+25);
  if (key === "classic") move(-25);
  saveConditions();
  run();
}

/**
 * 言葉で旅程を直します。
 *
 * AIがやるのは「言われたことを条件の書き換えに翻訳する」だけです。
 * 旅程は、これまでと同じ手順（営業時間と移動時間の照合）で組み直します。
 * AIに旅程そのものを作らせると、実行できない旅程が返ってきます。
 */
async function editPlan(text, itin, trip) {
  const patch = await parseEdit(text, itin,
    hasApiKey() ? { call: (prompt, o) => callModel(prompt, o) } : {});
  const said = describeEdit(patch, itin);
  if (patch.empty) return said;   // 読み取れないときは、何もしません

  const next = applyEdit(patch, trip);
  syncFormTo(next);
  state.trip = next;
  // 組み直すと画面が作り直されるので、返した文はそこで消えます。
  // 次に描かれる旅程へ持っていって、何をしたかを残します。
  state.editNote = said;
  run(next);
  return said;
}

/** 書き換えた条件を、左の入力欄に反映します。 */
function syncFormTo(t) {
  const iso = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      + `T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  $("#depart-at").value = iso(t.departAt);
  $("#arrive-by").value = iso(t.arriveBy);
  if (t.paceChosen) state.pace = t.pace;
  if ($("#hidden-bias")) {
    $("#hidden-bias").value = String(Math.round(t.hiddenBias * 100));
    renderStardust(Number($("#hidden-bias").value));
  }
  for (const chip of document.querySelectorAll(".md-chip[data-genre]")) {
    const on = t.interests.includes(chip.dataset.genre);
    chip.setAttribute("aria-pressed", String(on));
    chip.classList.toggle("is-selected", on);
  }
  state.avoidIds = t.must.avoidSpotIds;
  state.pinned.clear();
  for (const id of t.must.spotIds) {
    const spot = state.kb?.spotsById?.get(id);
    if (spot) state.pinned.set(id, spot);
  }
  renderPinned();
  updateWindowHelp();
  saveConditions();
}

function applySuggestion(s) {
  const a = s.apply ?? {};
  const dep = new Date($("#depart-at").value);
  const arr = new Date($("#arrive-by").value);
  const iso = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      + `T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  if (a.extendMinutes) {
    $("#arrive-by").value = iso(new Date(arr.getTime() + a.extendMinutes * 60000));
  }
  if (a.startEarlierMinutes) {
    $("#depart-at").value = iso(new Date(dep.getTime() - a.startEarlierMinutes * 60000));
  }
  if (a.addNights) {
    $("#arrive-by").value = iso(new Date(arr.getTime() + a.addNights * 86400000));
  }
  if (a.shortenDays) {
    $("#arrive-by").value = iso(new Date(arr.getTime() - a.shortenDays * 86400000));
  }
  if (a.pace) state.pace = a.pace;
  if (a.clearArea) state.clearArea = true;
  updateWindowHelp();
  run();
}

// --- 本体 -------------------------------------------------------------------

/**
 * 旅程を組みます。
 * @param {object} [override] 条件を指定する場合（言葉での修正など）。
 *   省略すると、左の入力欄から読みます。
 */
async function run(override) {
  const trip = override ?? readTrip();
  showError("");

  if (!trip.origin) {
    showError("出発地が見つかりません。一覧から駅名を選んでください。");
    return;
  }
  if (state.endMode === "other" && !trip.destination) {
    showError("終える場所が見つかりません。一覧から駅名を選んでください。");
    return;
  }
  const errors = validateTrip(trip);
  if (errors.length) { showError(errors.join(" / ")); return; }
  if (!state.kb) { showError("データを読み込めていません。"); return; }

  state.trip = trip;
  $("#placeholder").hidden = true;
  $("#result").hidden = true;
  $("#progress").hidden = false;
  const progress = $("#progress");
  const fab = $("#make-plan");
  fab.disabled = true;
  fab.querySelector(".fab-tx").textContent = "組み立てています…";
  // 出発地のあたりへ、背景の地図を寄せておきます
  moveBackgroundMap(trip.origin.lat, trip.origin.lng, 8);

  try {
    resetRoutesBreaker();
    const itin = await buildPlans(trip, progress);
    showRoutesUsage();
    show(itin, trip);
  } catch (e) {
    $("#progress").hidden = true;
    $("#placeholder").hidden = false;
    showError(e.message ?? String(e), e.suggestions ?? []);
  } finally {
    fab.disabled = false;
    fab.querySelector(".fab-tx").textContent = "旅程をつくる";
  }
}

/**
 * 3案を作って、おすすめを1つ選びます。
 *
 * 費用について
 * ------------
 * 案ごとに一から作り直すと、同じ希望文をモデルに3回読ませることに
 * なります。読み取り（understandRequest）と検索用ベクトルは1回だけ
 * 計算し、3案で使い回します。増えるのは「候補から選ぶ」呼び出しだけです。
 *
 * さらに、案を比べるあいだは **経路も天気も取りません**。
 * 採用が決まった案にだけ、実際の経路と天気を取りにいきます。
 */
async function buildPlans(trip, progress) {
  const onProgress = (step, note) => renderProgress(progress, step, note);
  const variants = tripsFor(trip);

  // 1案目。ここで希望文の読み取りと検索用ベクトルが決まります。
  const first = await planTrip({
    trip: variants[0].trip, kb: state.kb,
    ignoreAreas: state.clearArea,
    useRoutes: false, useWeather: false, onProgress,
  });

  // 残りの案は、読み取りを使い回して作ります。
  const rest = [];
  for (const v of variants.slice(1)) {
    onProgress(3, `${VARIANTS[v.key].label}の案を組み立てています`);
    try {
      rest.push({ key: v.key, trip: v.trip, itin: await planTrip({
        trip: v.trip, kb: state.kb,
        ignoreAreas: state.clearArea,
        useRoutes: false, useWeather: false,
        query: first.query, vector: first.vector,
      }) });
    } catch {
      // 成立しない案は、並べません（「作れませんでした」を3つ並べても
      // 選びようがありません）
    }
  }

  const plans = [{ key: variants[0].key, trip: variants[0].trip, itin: first },
                 ...rest];
  state.plans = plans;

  const best = recommendOf(plans) ?? plans[0];
  state.recommendKey = best.key;
  state.recommendWhy = best.reason ?? "";

  return finishPlan(best.key, onProgress);
}

/**
 * 採用した案だけ、実際の経路と天気を取って仕上げます。
 * ここが唯一の課金対象です。
 */
async function finishPlan(key, onProgress) {
  const chosen = (state.plans ?? []).find((p) => p.key === key);
  if (!chosen) throw new Error("その案が見つかりません");

  onProgress?.(4, `${VARIANTS[key].label}の経路と天気を確認しています`);
  const itin = await planTrip({
    trip: chosen.trip, kb: state.kb,
    ignoreAreas: state.clearArea,
    query: chosen.itin.query, vector: chosen.itin.vector,
    onProgress,
  });

  // 案の一覧（カードに出すぶんだけ）
  // 「何が違うのか」は、3案を並べて比べてから決めます。
  const diff = distinguishOf(state.plans ?? []);
  itin.variants = (state.plans ?? []).map((p) => ({
    key: p.key,
    score: p.itin?.score?.total ?? 0,
    summary: summaryOf(p.itin),
    distinct: diff.get(p.key) ?? "",
    fatigue: p.itin?.score?.fatigue ?? null,
  }));
  itin.variantKey = key;
  itin.recommendKey = state.recommendKey;
  itin.recommendWhy = state.recommendWhy;
  state.chosenTrip = chosen.trip;
  return itin;
}

/** 旅程のいちばん最後の時刻。帰りの余裕を出すために使います。 */
function lastEnd(itin) {
  const all = (itin.days ?? []).flatMap((d) => d.items ?? []);
  return all.length ? all.at(-1).end : itin.days?.[0]?.date;
}

/** 旅程に混ざっている情報の出どころを、ぜんぶ集めます。 */
function collectSources(itin) {
  const out = [];
  for (const day of itin.days ?? []) {
    for (const item of day.items ?? []) {
      if (item.kind === "spot" && item.place) {
        out.push(confidenceOf("hours", item.place));
      } else if (item.kind === "transit") {
        out.push(confidenceOf("travel", item));
      }
    }
  }
  return out;
}

/**
 * 旅程に混ざっている情報のうち、いちばん古いものの鮮度。
 *
 * 平均を出しても意味がありません。10件のうち9件が今日のもので、
 * 1件が3年前なら、その旅程で困るのは3年前の1件です。
 */
function oldestFreshness(itin) {
  let oldest = null;
  for (const day of itin.days ?? []) {
    for (const item of day.items ?? []) {
      const at = item.place?.fetchedAt;
      if (!Number.isFinite(at)) continue;
      if (oldest === null || at < oldest) oldest = at;
    }
  }
  return freshnessOf(oldest);
}

/** 案を選び直します。経路と天気は、選ばれた案にだけ取りにいきます。 */
async function switchVariant(key) {
  if (!state.plans?.length || key === state.trip?.__variantKey) { /* 続行 */ }
  const progress = $("#progress");
  $("#result").hidden = true;
  $("#progress").hidden = false;
  try {
    const itin = await finishPlan(key,
      (step, note) => renderProgress(progress, step, note));
    showRoutesUsage();
    state.trip = state.chosenTrip;
    syncFormTo(state.chosenTrip);
    show(itin, state.chosenTrip);
  } catch (e) {
    $("#progress").hidden = true;
    $("#result").hidden = false;
    showError(e.message ?? String(e));
  }
}

/**
 * 「今日の旅」を出すかどうかを決め、出します。
 * 旅の当日でなければ、何も出しません（当日でないのに
 * 「次はここです」と出しても、混乱するだけです）。
 */
function renderTodayBox(itin, trip) {
  const box = $("#today");
  if (!box) return;
  const now = new Date();
  const first = itin.days?.[0]?.date;
  const last = itin.days?.at(-1)?.items?.at(-1)?.end ?? itin.days?.at(-1)?.date;
  const during = first && last
    && now >= new Date(new Date(first).setHours(0, 0, 0, 0))
    && now <= new Date(new Date(last).getTime() + 6 * 3600000);
  box.hidden = !during;
  if (!during) return;

  // 遅れているかどうか。押された「着いた」から数えます。
  itin.catchUp = state.arrivedAtId
    ? catchUp(itin, now, { endBy: trip.arriveBy,
                           arrivedAtId: state.arrivedAtId })
    : null;

  renderToday(box, itin, trip, {
    now,
    onArrived: (id) => {
      state.arrivedAtId = id;
      renderTodayBox(itin, trip);
    },
    onCatchUp: (actions) => {
      // 短縮と削除を、条件の書き換えに直します。組み直しは
      // これまでと同じエンジンが行います。
      const drop = actions.filter((a) => a.kind === "drop" && a.spotId)
        .map((a) => a.spotId);
      const next = {
        ...state.trip,
        must: {
          ...state.trip.must,
          spotIds: [...(state.trip.must?.spotIds ?? [])],
          avoidSpotIds: [...new Set([
            ...(state.trip.must?.avoidSpotIds ?? []), ...drop])],
        },
        pace: "packed", paceChosen: true,
      };
      state.editNote = itin.catchUp.summary;
      state.trip = next;
      syncFormTo(next);
      run(next);
    },
  });
}

function show(itin, trip) {
  $("#progress").hidden = true;
  $("#result").hidden = false;
  // 直前に言葉で直した内容を、組み直したあとの画面にも残します
  itin.editNote = state.editNote ?? "";
  state.editNote = "";

  // なぜこの旅程なのか、どれくらい余裕があるのか、情報はどこから来たのか。
  // どれもプログラム側で数えます（AIには採点させません）。
  itin.fit = tripFit(itin, trip);
  itin.pace = paceBreakdown(itin);
  itin.slack = slackLevel(itin.days?.at(-1)
    ? Math.round((trip.arriveBy - lastEnd(itin)) / 60000) : null);
  itin.sourceMix = describeSource(collectSources(itin));
  // 「確認済み」と「最新」は別のことなので、分けて出します。
  // いちばん古い1件を、旅程全体の鮮度とします。
  itin.freshness = oldestFreshness(itin);

  // スポットごとの「選んだ理由」も、軸つきにします。
  let prev = null;
  for (const day of itin.days ?? []) {
    for (const item of day.items ?? []) {
      if (item.kind !== "spot" || !item.place) continue;
      item.fit = spotFit(item.place, trip, {
        at: item.start,
        fromKm: prev ? haversineKm(prev, item.place) : undefined,
      });
      prev = item.place;
    }
  }

  // 旅の当日は、「今日の旅」を旅程の上に出します。
  // 当日に知りたいのは、次に何をすればいいかだけです。
  renderTodayBox(itin, trip);

  renderItinerary($("#itinerary"), itin, trip, {
    onBack: () => {
      $("#result").hidden = true;
      $("#placeholder").hidden = false;
    },
    onShare: () => shareConditions(trip),
    onDay: (index) => state.map.showDay(index),
    onHover: (item, on) => state.map.highlight(item.spotId, on),
    onSuggest: applySuggestion,
    onAdjust: adjustPlan,
    onVariant: (key) => switchVariant(key),
    onEdit: (text) => editPlan(text, itin, trip),
    onReplan: (picked) => {
      // 選ばれたぶんだけ条件に足して、同じ手順で組み直します。
      const next = applyReplan(trip, picked);
      syncFormTo(next);
      state.trip = next;
      state.editNote = picked.length === 1
        ? picked[0].text
        : `天気・日没・混雑から ${picked.length}件 を反映して組み直しました。`;
      run(next);
    },
    onSpot: (item) => {
      state.map.focus(item.place.lat, item.place.lng);
      openSheet(item, { describe: (s) => describeSpot(s) });
    },
  });

  rememberTrip(itin, trip);

  const points = pointsFromItinerary(itin, trip);
  state.map.render(points);
  state.map.invalidate();
  // 背景の地図も、その旅先へ寄せます。左で条件を直しているあいだも
  // 「いまどこの話をしているか」が背後に残ります。
  const first = points.find((p) => p.kind === "spot") ?? points[0];
  if (first) moveBackgroundMap(first.lat, first.lng, 9);
}

document.addEventListener("DOMContentLoaded", boot);
