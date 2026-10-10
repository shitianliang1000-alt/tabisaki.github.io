// できあがった旅程そのものを、リンクにする。
//
// 「条件のリンク」（?p=）は条件だけを運びます。受け取った人が開くと、
// その場で組み直されるので、AIの選び方も調べた便も変わります。
// 同行者に LINE で「この旅程で行こう」と送っても、相手の画面には
// 別の旅程が出ていました。
//
// ここでは、**画面に出ている旅程をそのまま**リンクに詰めます。
//
//   ・中身は js/transfer.js のファイルと同じ形です（凍結した旅程）。
//     読むときも同じ検査（readTripFile）を通します。
//   ・どこにも保存しません。旅程はリンクの # の後ろに入っていて、
//     # の後ろはブラウザがサーバへ送りません。中継にも、GitHub にも
//     届きません。
//   ・縮めるのはブラウザに入っている deflate（CompressionStream）です。
//     ライブラリは足しません。
//
// 長さについて
// ------------
// 旅程1本は、縮めて base64 にしても、日帰りで約7,000字、5日で
// 約16,000字になります（東京発の試算）。メールやメッセージの多くは
// その長さのリンクも運べますが、1通の字数に上限のあるアプリでは
// 入りきらないことがあります。短くするにはどこかに旅程を預ける必要があり、それは
// このアプリの「どこにも送らない」と両立しません。MAX_LINK_CHARS を
// 超えるときは、ファイルで渡す（js/transfer.js）ように案内します。

import { readTripFile, toTripFile } from "./transfer.js";

/** リンクの # の後ろの名前。`#t=…` */
export const HASH_KEY = "t";

/**
 * これより長いリンクは作りません。
 *
 * ブラウザ自体は数十万字の URL も開けますが、メッセージアプリの中には
 * 長いリンクを途中で切るもの、リンクとして扱わないものがあります。
 * 途中で切れた旅程は開けないので、出さないほうがましです。
 */
export const MAX_LINK_CHARS = 30000;

/**
 * リンクに入れない項目。
 *
 * 開き直すのに要らないもの、あるいは収録データの丸写しです。
 * 検索用のベクトル（v / vector）は数百の数で、1件で旅程まるごとより
 * 長くなります。
 */
const DROP = new Set(["replan", "variants", "candidates", "v", "vector",
                      "query", "suggestions", "onRebuild"]);

/** 移動の両端に要るのは、名前と位置だけです（道順のリンクに使います）。 */
const ENDS = new Set(["from", "to"]);

function slim(key, value) {
  if (DROP.has(key)) return undefined;
  // 移動の両端は、立ち寄りの place と同じものの写しです。説明や
  // 公式サイトまで写すと、5日の旅程では中身の3分の1がこれになります。
  if (ENDS.has(key) && value && typeof value === "object"
      && Number.isFinite(value.lat) && Number.isFinite(value.lng)) {
    const { id, name, lat, lng } = value;
    return { id, name, lat, lng };
  }
  return value;
}

// 先頭の1文字で、中身の詰めかたを表します。
//   z … deflate-raw で縮めたもの
//   j … 縮めていないもの（CompressionStream の無い古いブラウザ）
const DEFLATE = "z";
const PLAIN = "j";

function hasStreams() {
  return typeof CompressionStream === "function"
    && typeof DecompressionStream === "function";
}

async function pipeBytes(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function toBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 旅程を、リンクの # の後ろに入れる文字列にします。
 *
 * @param {{title?:string, state?:object, trip?:object, itin:object}} entry
 *   js/transfer.js の toTripFile に渡すものと同じ（凍結済みの旅程）
 * @returns {Promise<string>} `z…` / `j…`
 */
export async function packTrip(entry) {
  const doc = toTripFile({ ...entry, id: null });
  const json = JSON.stringify(doc, slim);
  const bytes = new TextEncoder().encode(json);
  if (hasStreams()) {
    const packed = await pipeBytes(bytes, new CompressionStream("deflate-raw"));
    return DEFLATE + toBase64Url(packed);
  }
  return PLAIN + toBase64Url(bytes);
}

/**
 * リンクから旅程を取り出します。
 *
 * **黙って読み違えません。** 途中で切れたリンク、別のアプリのリンクは、
 * 何が違うのかを返します（readTripFile と同じ約束です）。
 *
 * @param {string} code packTrip の結果
 * @returns {Promise<{ok:true, trip:object}|{ok:false, error:string}>}
 */
export async function unpackTrip(code) {
  const text = String(code ?? "");
  const kind = text[0];
  let json = "";
  try {
    const bytes = fromBase64Url(text.slice(1));
    if (kind === DEFLATE) {
      if (!hasStreams()) {
        return { ok: false,
                 error: "このブラウザでは、旅程のリンクを開けません。"
                   + "新しいブラウザで開くか、ファイルで受け取ってください。" };
      }
      json = new TextDecoder().decode(
        await pipeBytes(bytes, new DecompressionStream("deflate-raw")));
    } else if (kind === PLAIN) {
      json = new TextDecoder().decode(bytes);
    } else {
      return { ok: false, error: "旅程のリンクではないようです。" };
    }
  } catch {
    return { ok: false,
             error: "旅程のリンクが途中で切れているようです。"
               + "送ってくれた人に、もう一度送ってもらってください。" };
  }
  const out = readTripFile(json);
  if (!out.ok) return out;
  return { ok: true, trip: out.trips[0] };
}

/**
 * 旅程のリンクを作ります。長すぎるときは null（ファイルで渡します）。
 *
 * @param {object} entry packTrip と同じ
 * @param {string} base 開く先（location.origin + location.pathname）
 */
export async function tripLink(entry, base) {
  const code = await packTrip(entry);
  const url = `${base}#${HASH_KEY}=${code}`;
  return url.length <= MAX_LINK_CHARS ? url : null;
}

/** `#t=…` から中身を取り出します。旅程のリンクでなければ空文字。 */
export function tripCodeFrom(hash) {
  const h = String(hash ?? "").replace(/^#/, "");
  if (!h.startsWith(`${HASH_KEY}=`)) return "";
  return h.slice(HASH_KEY.length + 1);
}

