#!/bin/sh
# 外部ライブラリを自分の手元に取り込む。
#
# なぜ必要か
# ----------
# いまの index.html は Leaflet を unpkg.com から読んでいます。旅行サイトは
# 移動中・低速回線・海外回線で開かれます。一般的なサイト以上に、
# 「他所のサーバが遅い／届かない」の影響を受けます。
#
# それに、CDN から読むかぎり、**配られる中身が変わっても気づけません**。
# バージョンを固定していても、その URL が返すものが差し替われば、
# こちらのページで実行されます。
#
# このスクリプトは2つのことをします。
#   1. Leaflet を vendor/ に置く（自分のサーバから配る）
#   2. SRI ハッシュを表示する（CDN を使い続ける場合の担保）
#
# 使いかた
#   sh tools/vendor.sh
#   → vendor/ に置かれ、index.html の書き換えかたが表示されます

set -eu
VER=1.9.4
BASE="https://unpkg.com/leaflet@${VER}/dist"
OUT=vendor

mkdir -p "$OUT"
for f in leaflet.js leaflet.css; do
  echo "取得中: ${BASE}/${f}"
  curl -fsS -o "${OUT}/${f}" "${BASE}/${f}"
done
# 画像（マーカーなど）も要ります。css が images/ を参照します。
mkdir -p "${OUT}/images"
for f in marker-icon.png marker-icon-2x.png marker-shadow.png layers.png layers-2x.png; do
  curl -fsS -o "${OUT}/images/${f}" "${BASE}/images/${f}" || true
done

echo
echo "=== 自分のサーバから配る場合 ==============================="
echo "index.html の unpkg の2行を、こう置き換えてください:"
echo '  <link rel="stylesheet" href="vendor/leaflet.css">'
echo '  <script src="vendor/leaflet.js"></script>'
echo
echo "=== CDN を使い続ける場合（SRI を付ける） ==================="
for f in leaflet.js leaflet.css; do
  h=$(openssl dgst -sha384 -binary "${OUT}/${f}" | openssl base64 -A)
  echo "  ${f}: integrity=\"sha384-${h}\" crossorigin=\"anonymous\""
done
echo
echo "SRI を付けると、配られた中身が変わった時点でブラウザが実行を"
echo "拒みます。ハッシュはバージョンごとに変わるので、Leaflet を"
echo "上げるときは、このスクリプトを流し直してください。"
