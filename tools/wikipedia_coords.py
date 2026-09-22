# -*- coding: utf-8 -*-
"""ウィキペディアの配布ファイルから、記事名 → 座標の表を作る。

    python3 tools/wikipedia_coords.py          作る（無ければ落とす）
    python3 tools/wikipedia_coords.py --stats  何件あるかだけ見る

なぜ API ではなく配布ファイルなのか
------------------------------------
座標は API（prop=coordinates）でも引けます。実際そうしていました。ただし
50件ずつしか聞けないので、3万件の記事を引くと **600回**の問い合わせに
なります。8秒あけても80分、そのあいだじゅう相手の回線を占めます。

そして実際に、途中から断られ始めました。

    429 … 15秒待ちます
    429 … 45秒待ちます
    429 … 300秒待ちます
    429 … 600秒待ちます

断られたときに返ってくる案内（Wikimedia APIs/Rate limits）は、
**まとめて欲しいなら配布ファイルを使え**と書いてあります。そのとおりに
しました。

    jawiki-latest-geo_tags.sql.gz     6MB   記事の番号 → 緯度経度
    jawiki-latest-page.sql.gz       163MB   記事の番号 → 記事名

2本落として突き合わせれば、**日本語版の座標つき記事がぜんぶ**手に入り
ます。問い合わせは2回です。相手にとっても、こちらにとっても軽い。

SQL を読むことについて
----------------------
中身は MySQL の INSERT 文です。本物の SQL 構文解析はしません——値の並び
`(1,2,'x'),(3,4,'y')` を読むだけです。ウィキメディアはこの形式を10年以上
変えていませんし、形が変わればここは**何も返しません**（黙って半分だけ
読むより、何も返らないほうが気づけます）。
"""
import gzip
import io
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
OUT = os.path.join(WEB, "data", "wikipedia")
DUMPS = os.path.join(OUT, "dumps")

BASE = "https://dumps.wikimedia.org/jawiki/latest"
UA = ("tabisaki-kb/1.0 (https://github.com/shitianliang1000-alt/"
      "tabisaki.github.io; kb build)")

GEO = "jawiki-latest-geo_tags.sql.gz"
PAGE = "jawiki-latest-page.sql.gz"
REDIR = "jawiki-latest-redirect.sql.gz"

# 日本の四隅。これより外は、日本語版に載っていても日本の場所ではありません
# （パリのノートルダムにも日本語版の記事があり、座標も付いています）。
BBOX = (20.0, 46.5, 122.0, 154.5)


def have(name):
    return os.path.exists(os.path.join(DUMPS, name))


def download(name):
    """配布ファイルを1本落とします。**途中で切れたものは消します。**

    半分だけのファイルを残すと、次に走らせたときに「もうある」と見なして
    そのまま読み、**記事の半分だけが座標を持つ**表ができます。どの記事が
    欠けたのかは、できた表からは分かりません。
    """
    os.makedirs(DUMPS, exist_ok=True)
    path = os.path.join(DUMPS, name)
    tmp = path + ".part"
    sys.stderr.write(f"  {name} を落とします…\n")
    r = subprocess.run(["curl", "-sS", "-f", "-m", "3600", "-A", UA,
                        "-o", tmp, f"{BASE}/{name}"])
    if r.returncode != 0 or not os.path.exists(tmp):
        if os.path.exists(tmp):
            os.remove(tmp)
        raise SystemExit(f"{name} を落とせませんでした。")
    os.replace(tmp, path)


# 括弧ひと組ぶん。引用符の中の括弧は切りません。
ROW = re.compile(rb"\(((?:[^()']|'(?:[^'\\\\]|\\\\.)*')*)\)")


def rows(path):
    """配布ファイルから、値の並びを1行ずつ返します。

    **2つの書き方に備えます。** いまの配布ファイルは1行に1件

        (4713239,2565169,'earth',1,32.68115500,130.99273000,NULL,…),

    ですが、以前は `INSERT INTO ... VALUES (…),(…),(…);` と1行に
    まとめて入っていました。どちらでも読めるようにしておきます。

    最初にこれを書いたとき、`INSERT INTO` で始まる行だけを見ていました。
    いまの書き方では `INSERT INTO `geo_tags` VALUES` のあとに改行が入る
    ので、**データの行を1つも読みませんでした**。0件で止まったので
    気づけましたが、これが「半分読めた」だったら気づけませんでした。
    """
    with gzip.open(path, "rb") as f:
        for line in f:
            if not (line.startswith(b"(") or line.startswith(b"INSERT INTO")):
                continue
            for m in ROW.finditer(line):
                yield m.group(1)


def fields(blob):
    """`1,2,'x',NULL` を並びに割ります。引用符の中のカンマは切りません。"""
    out, cur, quoted, esc = [], bytearray(), False, False
    for b in blob:
        c = bytes([b])
        if esc:
            cur += c
            esc = False
        elif c == b"\\":
            esc = True
            cur += c
        elif c == b"'":
            quoted = not quoted
            cur += c
        elif c == b"," and not quoted:
            out.append(bytes(cur))
            cur = bytearray()
        else:
            cur += c
    out.append(bytes(cur))
    return out


def unquote(v):
    if len(v) >= 2 and v[:1] == b"'":
        v = v[1:-1]
    return v.replace(b"\\'", b"'").replace(b'\\"', b'"') \
            .replace(b"\\\\", b"\\").decode("utf-8", "replace")


def geo_by_page():
    """記事の番号 → (緯度, 経度)。日本の範囲のものだけ。

    1つの記事に座標が何本も付くことがあります（本社と工場、のように）。
    **primary の1本だけ**を採ります。どれが代表かは向こうが決めています。
    """
    path = os.path.join(DUMPS, GEO)
    lo_lat, hi_lat, lo_lng, hi_lng = BBOX
    out = {}
    for blob in rows(path):
        f = fields(blob)
        # gt_id, gt_page_id, gt_globe, gt_primary, gt_lat, gt_lon, …
        if len(f) < 6:
            continue
        try:
            page_id = int(f[1])
            primary = int(f[3])
            lat = float(f[4])
            lng = float(f[5])
        except ValueError:
            continue
        if not primary or page_id in out:
            continue
        if unquote(f[2]) != "earth":
            continue
        if not (lo_lat <= lat <= hi_lat and lo_lng <= lng <= hi_lng):
            continue
        out[page_id] = (round(lat, 5), round(lng, 5))
    return out


def ns0_titles():
    """記事の番号 → 記事名（標準名前空間だけ）と、転送の番号の集まり。

    座標のある記事だけを拾っていた時期がありましたが、それでは
    **転送（リダイレクト）が拾えません**。「シギラ温泉」「酸ヶ湯」の
    ような名前は一覧記事から張られていても、記事の実体は別の題に
    あります。転送の側には座標が付かないので、座標表に当たりません。

    転送も含めて、標準名前空間の題をぜんぶ覚えます。
    """
    path = os.path.join(DUMPS, PAGE)
    names, redirects = {}, set()
    for blob in rows(path):
        f = fields(blob)
        # page_id, page_namespace, page_title, …, page_is_redirect, …
        if len(f) < 5:
            continue
        try:
            page_id = int(f[0])
            ns = int(f[1])
        except ValueError:
            continue
        if ns != 0:
            continue
        names[page_id] = unquote(f[2]).replace("_", " ")
        try:
            if int(f[3]):
                redirects.add(page_id)
        except ValueError:
            pass
    return names, redirects


def redirect_targets(redirects):
    """転送の番号 → 転送先の記事名（標準名前空間だけ）。"""
    path = os.path.join(DUMPS, REDIR)
    out = {}
    for blob in rows(path):
        f = fields(blob)
        # rd_from, rd_namespace, rd_title, rd_interwiki, rd_fragment
        if len(f) < 3:
            continue
        try:
            rd_from = int(f[0])
            ns = int(f[1])
        except ValueError:
            continue
        if ns != 0 or rd_from not in redirects:
            continue
        out[rd_from] = unquote(f[2]).replace("_", " ")
    return out


def build():
    for name in (GEO, PAGE, REDIR):
        if not have(name):
            download(name)
    sys.stderr.write("  座標を読んでいます…\n")
    geo = geo_by_page()
    sys.stderr.write(f"    日本の範囲に座標がある記事 {len(geo)}件\n")

    sys.stderr.write("  記事名を読んでいます…\n")
    names, redirects = ns0_titles()
    sys.stderr.write(f"    標準名前空間の記事 {len(names)}件"
                     f"（うち転送 {len(redirects)}件）\n")

    table = {}
    for page_id, pos in geo.items():
        title = names.get(page_id)
        if title:
            table[title] = list(pos)

    sys.stderr.write("  転送を読んでいます…\n")
    targets = redirect_targets(redirects)
    added = 0
    for page_id, target in targets.items():
        title = names.get(page_id)
        # **転送先が座標を持っているときだけ**足します。転送先にも座標が
        # 無いなら、その題はどのみち場所ではありません。
        if title and title not in table and target in table:
            table[title] = table[target]
            added += 1
    sys.stderr.write(f"    転送から {added}件\n")

    if len(table) < 10000:
        # 日本語版の座標つき記事は十数万件あります。1万を切るのは、
        # 配布ファイルの形が変わったか、落とし損ねたかのどちらかです。
        # **半分だけの表を保存しません。**
        raise SystemExit(
            f"座標つきの記事が {len(table)}件 しかありません。\n"
            "  配布ファイルの形が変わったか、落とし損ねています。\n"
            "  data/wikipedia/dumps/ を消して、もう一度走らせてください。")
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "coords.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(table, f, ensure_ascii=False, separators=(",", ":"))
    sys.stderr.write(f"  {len(table)}件を {path} に書きました\n")
    return table


def load():
    """できている表を読みます。無ければ作ります。"""
    path = os.path.join(OUT, "coords.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return build()


if __name__ == "__main__":
    if "--stats" in sys.argv:
        t = load()
        print(f"座標つきの記事 {len(t)}件")
        for name in list(t)[:5]:
            print(f"  {name}  {t[name]}")
    else:
        build()
