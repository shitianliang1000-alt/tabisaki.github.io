import { endpointFor } from "./endpoints.js";
import { effectiveConfig } from "./settings.js";

/**
 * Yahoo!路線情報の検索をバックエンド経由で実行します。
 *
 * 旅程で使うのは「この日、この時刻に出発地を出たら、次に乗れる
 * 公共交通で何時に到着するか」です。日時はそのまま渡します。
 */
/**
 * 断られたら、しばらく置いてから。
 *
 * 続けて何度も聞くと、Yahoo!からも中継の回数制限からも断られます（429）。
 * そこで**急がず**、失敗したら待ってもう一度、それでも駄目なら
 * しばらく聞かない、という形にします。旅程1つで区間の数だけ聞くので、
 * 断られた直後に残りを投げても、全部断られるだけです。
 */
const RETRY_WAIT_MS = [1500, 5000, 12000];
const COOLDOWN_MS = 60000;
const cooldown = { until: 0, reason: "" };

/** いま聞ける状態か。旅程を組む側が、無駄な呼び出しを避けるために見ます。 */
export function yahooCooldown(now = Date.now()) {
  const left = Math.max(0, cooldown.until - now);
  return { waiting: left > 0, seconds: Math.ceil(left / 1000),
           reason: cooldown.reason };
}

export function resetYahooCooldown() { cooldown.until = 0; cooldown.reason = ""; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function searchYahooTransit(from, to, opts = {}) {
  const cfg = effectiveConfig();
  const fromName = String(from?.name ?? from ?? "").trim();
  const toName = String(to?.name ?? to ?? "").trim();
  if (!fromName || !toName) return null;

  // 断られた直後は、間を置きます。ここで投げても、また断られます。
  const wait = yahooCooldown();
  if (wait.waiting && !opts.force) {
    const e = new Error(`あと約${wait.seconds}秒お待ちください（${wait.reason}）`);
    e.status = 429;
    e.retryAfter = wait.seconds;
    throw e;
  }

  // **頼まれた日時で調べます。**
  //
  // 以前は、過ぎた日なら「いま」、先すぎる日なら「同じ曜日の来週」に
  // 寄せていました。返ってくるのは別の日の便なので、旅程の時刻と
  // 食い違います（9月6日4:00発の旅程に「14:50発→18:40着」）。
  // Yahoo!は過ぎた日でもその日のダイヤで答えるので、寄せる必要は
  // ありませんでした。答えられない日はYahoo!がそう言います。
  const requested = opts.departAt ? new Date(opts.departAt) : neutralDepartureTime();
  const departAt = Number.isNaN(requested.getTime())
    ? neutralDepartureTime() : requested;

  const body = JSON.stringify({
    from: fromName,
    to: toName,
    departAt: departAt.toISOString(),
  });
  const url = endpointFor("yahoo:transit", {}, cfg);

  // 待ち時間は差し替えられます（テストで18秒待たないため）。
  const waits = Array.isArray(opts.retryWaits) ? opts.retryWaits : RETRY_WAIT_MS;
  let lastError = null;
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    if (attempt > 0) {
      // 待つ時間は、回を追うごとに伸ばします。同じ間隔で叩き続けても、
      // 相手の側の事情は変わりません。
      await sleep(waits[attempt - 1]);
    }
    let res;
    try {
      res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body, signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      lastError = e;
      continue;                       // 通信そのものの失敗。待って、もう一度。
    }
    if (res.ok) {
      resetYahooCooldown();
      const doc = await res.json();
      return { ...doc, searchedAt: departAt.toISOString() };
    }

    // 番号だけを投げていました。「Yahoo Transit 429」と出ても、
    // 断ったのがYahoo!なのか、中継の回数制限なのかが分かりません。
    // 待つ先が違うので、本文をそのまま添えます。
    const why = await res.text().then(
      (t) => { try { return JSON.parse(t)?.error?.message ?? ""; } catch { return ""; } },
      () => "");
    const err = new Error(why || `Yahoo Transit ${res.status}`);
    err.status = res.status;
    err.retryAfter = Number(res.headers?.get?.("Retry-After")) || null;
    lastError = err;
    // 断られた（429）か、上流が不調（5xx）のときだけ、待って試します。
    // 400番台のほかは、待っても同じ答えです。
    if (res.status !== 429 && res.status < 500) throw err;
  }

  // ここまで来たら、しばらく聞きません。旅程1つで区間の数だけ聞くので、
  // 断られた直後に残りを投げても、全部断られるだけです。
  cooldown.until = Date.now()
    + Math.max(COOLDOWN_MS, (lastError?.retryAfter ?? 0) * 1000);
  cooldown.reason = String(lastError?.message ?? "断られました").slice(0, 60);
  throw lastError ?? new Error("Yahoo!路線情報に接続できませんでした");
}

function neutralDepartureTime(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d;
}
