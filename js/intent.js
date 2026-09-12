// 希望文から、乗り物と旅のしかたの指定を読み取る。
//
// 書かれていることの多くは「どこへ行きたいか」ですが、**どう行きたいか**
// を書く人もいます。
//
//     サンライズに乗って山陰へ
//     観光列車に乗りたい
//     ツーリングをしたい
//     レンタカーで回りたい
//
// これまでは、どれも素通りしていました。文の中の語はスポット名との
// 照合にしか使われないので、「ツーリング」に合うスポットが無ければ
// 無視されます。結果、バイクで回りたい人に「徒歩15分」の旅程が出ます。
//
// ここで読み取るのは2つだけです。
//
//   transport … 何で移動するか（画面の選択と同じ値）
//   notes     … 旅程に添える一言（何を読み取ったかを、読む人に見せる）
//
// **読み取れないものは、読み取れないままにします。** 「サンライズ」は
// 寝台特急の名前で、時刻表は引けますが席の有無までは分かりません。
// 分かるのは「夜行で移動したいらしい」ということだけです。そこまでを
// 伝えて、あとは本人に任せます。

/**
 * 乗り物の指定。長い言い回しから順に見ます（「レンタカー」を
 * 「カー」で拾わないように）。
 */
const VEHICLES = [
  { re: /ツーリング|バイク|オートバイ|motorcycle|touring/i,
    transport: "car",
    note: "バイクで回る前提で、道のりから所要時間を見ています"
      + "（電車・バスの時刻表は使いません）" },
  // 「車で」は、**前の字を見ないと当たります**。「電車で回りたい」の
  // 中にも「車で」が入っているので、電車の指定を車と読んでいました。
  { re: /レンタカー|マイカー|自家用車|(?<![電列汽馬])車で|ドライブ|rent-?a-?car|by car|driving/i,
    transport: "car",
    note: "車で回る前提で、道のりから所要時間を見ています" },
  { re: /自転車|サイクリング|チャリ|cycling|bicycle/i,
    transport: "walk",
    note: "自転車で回る前提です。所要時間は徒歩に近い見かたをしています" },
  { re: /歩いて|散策|街歩き|walking|on foot/i,
    transport: "walk",
    note: "歩いて回れる範囲で組んでいます" },
  { re: /青春18|18きっぷ|鈍行|各駅停車|普通列車のみ/,
    transport: "transit",
    note: "普通列車で回る前提です。特急・新幹線の指定はできないので、"
      + "実際の便は時刻表でご確認ください" },
  { re: /電車|列車|鉄道|バスで|公共交通|by train|railway/i,
    transport: "transit",
    note: "電車・バスで回る前提です" },
];

/**
 * 特定の列車・船。名前は分かっても、席が取れるかまでは分かりません。
 * 分かるところまでを伝えて、確かめかたを添えます。
 */
const NAMED_SERVICES = [
  // 夜行は、区間として組み込めます（js/night-train.js）。ここでは
  // 「どの列車を狙っているか」だけを拾い、時刻はそちらの表から引きます。
  { re: /サンライズ出雲|sunrise izumo/i, nightTrain: "sunrise-izumo" },
  { re: /サンライズ瀬戸|sunrise seto/i, nightTrain: "sunrise-seto" },
  { re: /サンライズ|寝台特急|sunrise/i, nightTrain: "any" },
  { re: /観光列車|トロッコ列車|SL|蒸気機関車|ジョイフルトレイン/,
    note: "観光列車は運転日が限られ、座席の指定が要るものがほとんどです。"
      + "旅程では普通の移動として見ているので、乗りたい列車が決まって"
      + "いれば、その時刻に合わせて前後をずらしてください" },
  { re: /夜行|ムーンライト|overnight/i, nightTrain: "any" },
  { re: /フェリー|客船|ferry/i,
    note: "フェリーは便数が少なく、時刻表も別系統です。"
      + "航路がある区間は、運航会社の時刻表でご確認ください" },
];

/**
 * 希望文から、乗り物と添える一言を読み取ります。
 *
 * @param {string} text
 * @returns {{transport: string|null, notes: string[], nightTrain: string|null}}
 *   transport が null なら、指定は読み取れていません（画面の選択に従います）。
 *   nightTrain は狙っている夜行列車の id（"any" なら列車の指定なし）。
 */
export function readIntent(text) {
  const s = String(text ?? "");
  const notes = [];
  let transport = null;

  for (const v of VEHICLES) {
    if (!v.re.test(s)) continue;
    transport = v.transport;
    notes.push(v.note);
    break;                      // いちばん具体的な1つだけ
  }
  let nightTrain = null;
  for (const n of NAMED_SERVICES) {
    if (!n.re.test(s)) continue;
    if (n.note) notes.push(n.note);
    // いちばん具体的な指定を採ります（「サンライズ出雲」>「サンライズ」）。
    if (n.nightTrain && (!nightTrain || nightTrain === "any")) {
      nightTrain = n.nightTrain;
    }
  }
  return { transport, notes, nightTrain };
}
