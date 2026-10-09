// 圏外であることを、画面に書く。
//
// 圏外でも旅程は組めます（移動時間は距離からの目安、行き先は収録から）。
// ところが**黙って**組むと、目安の時刻が実際の時刻表のように読まれます。
// 山の中で「11:42発」を信じて駅へ歩き、便が無い——を起こさないために、
// つながっていないあいだは、そのことを1行で出しておきます。
//
// 何ができて何ができないかも、一緒に書きます。「オフラインです」だけでは、
// 保存した旅程まで開けないのか、と思わせてしまいます。

/** 圏外のあいだに出す文。 */
export const OFFLINE_TEXT =
  "圏外です。保存した旅程は開けます。新しく組むと、移動時間は距離からの目安になります。";

/** つながり直したときに、少しだけ出す文。 */
export const BACK_ONLINE_TEXT = "つながりました。";

/** 戻ったことを知らせる文を、どれだけ出しておくか。 */
const BACK_MS = 4000;

/**
 * つながり具合を見張って、帯の表示を切り替えます。
 *
 * `navigator.onLine` が false なのは「確実につながっていない」ときだけです
 * （true でも外へ出られないことはあります）。なので、出すのは false の
 * ときだけにします。true を「つながっています」とは書きません。
 *
 * @param {HTMLElement} bar   帯（role="status" を付けておくこと）
 * @param {object} [env]      試験のための差し替え
 * @param {{onLine:boolean}} [env.nav]
 * @param {EventTarget} [env.win]
 * @param {Function} [env.setTimer]
 * @param {Function} [env.clearTimer]
 * @returns {() => void} 見張りをやめる関数
 */
export function watchConnection(bar, {
  nav = globalThis.navigator,
  win = globalThis,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  let timer = null;
  const show = (text, offline) => {
    bar.textContent = text;
    bar.hidden = !text;
    bar.classList.toggle("is-offline", offline);
    bar.ownerDocument?.body?.classList?.toggle("offline", offline);
  };
  const update = () => {
    if (timer) { clearTimer?.(timer); timer = null; }
    if (nav?.onLine === false) {
      show(OFFLINE_TEXT, true);
      return;
    }
    // 圏外の帯を出していたときだけ、戻ったことを伝えます。
    // 最初からつながっているのに「つながりました」は要りません。
    if (bar.classList.contains("is-offline")) {
      show(BACK_ONLINE_TEXT, false);
      timer = setTimer?.(() => { timer = null; show("", false); }, BACK_MS);
    } else {
      show("", false);
    }
  };
  update();
  win?.addEventListener?.("online", update);
  win?.addEventListener?.("offline", update);
  return () => {
    win?.removeEventListener?.("online", update);
    win?.removeEventListener?.("offline", update);
    if (timer) clearTimer?.(timer);
  };
}

/** 圏外かどうか（分からないときは「つながっている」とみなします）。 */
export function isOffline(nav = globalThis.navigator) {
  return nav?.onLine === false;
}
