# -*- coding: utf-8 -*-
"""同じ場所が、別の名前で二重に収録されているものをまとめる。

収録は複数の出典を継ぎ足して作られているので、同じ建物が別々の名前で
入っていることがあります。

    萬翠荘(愛媛県立美術館分館郷土美術館)   n0131-1
    愛媛県美術館分館郷土美術館             p27-414

このままだと、同じ場所が1つの旅程に2回出ます。しかも座標が食い違って
いることがあり（阿波おどり会館は862m離れていました）、どちらを信じるかで
移動時間が変わります。

同一と見なす条件（**名前が同じでも別の場所**を巻き込まないように）:

  ・正規化（全角半角・記号・「市立」等を落とす）して名前が一致する
  ・または、括弧の中が相手の名前そのもの（別名として書かれている）
  ・または、片方だけ括弧つきで、括弧の外が相手の名前と一致する
  ・そのうえで 2km 以内

括弧の中どうしの一致は見ません。「(海水浴場)」「(駐車場)」のような
分類の札が入っていることが多く、逗子海水浴場と森戸海水浴場を同じものに
してしまいます。

座標が食い違うときは、**黙って選びません**。どちらが正しいかは名前からは
分からないので、CONFIRMED に書いたものだけ差し替え、残りは報告します。

    python3 tools/dedupe_spots.py --check   確認するだけ
    python3 tools/dedupe_spots.py --write   まとめて書き戻す
"""
import glob
import json
import math
import os
import re
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)

MERGE_RADIUS_KM = 2.0
# 座標がこれ以上離れていたら、どちらかが間違っています。
CONFLICT_KM = 0.2

# 座標の食い違いを調べて確かめたもの。「この id の座標を採る」。
CONFIRMED = {
    # 阿波おどり会館は徳島市新町橋、眉山のふもと。p27 側が現地に一致します
    # （naruto-3 は約860m東で、エリアも鳴門になっていました）。
    ("naruto-3", "p27-510"): "p27-510",
    # 二見興玉神社（夫婦岩）は ise-4 側が現地に一致します。
    ("ise-4", "n0100-16"): "ise-4",
}


# 同じ場所を別々に書いてしまう、字の揺れ。ここを畳んでから比べます。
# **意味の違う字は入れません。**「春/秋」「第1/第2」「燕/関」を畳むと、
# 別の催しや別の施設が同じものになります。
VARIANTS = str.maketrans({
    "ヶ": "ケ", "ヵ": "カ",
    "ァ": "ア", "ィ": "イ", "ゥ": "ウ", "ェ": "エ", "ォ": "オ",
    "溜": "留", "𠮷": "吉", "﨑": "崎", "髙": "高", "濵": "浜", "槗": "橋",
})


def clean(name):
    n = unicodedata.normalize("NFKC", name)
    n = re.sub(r"[\s　・､,、\-−―/／]", "", n)
    # 「市立」と「市」、「県立」と「県」を同じにします。出典によって
    # 「愛媛県立美術館分館」「愛媛県美術館分館」と揺れるためです。
    n = re.sub(r"(市|町|村|区|県|都|府|道|国)立", r"\1", n)
    return n.translate(VARIANTS)


def parts(name):
    """全体・括弧の外・括弧の中。括弧が無ければ paren は None。"""
    n = unicodedata.normalize("NFKC", name)
    m = re.search(r"[（(](.+?)[)）]", n)
    paren = clean(m.group(1)) if m else None
    base = clean(re.sub(r"[（(].*?[)）]", "", n))
    return clean(n), base, paren


# 「○○市立」「国営」など、付いていても付いていなくても同じ場所を指す頭。
#
#   平川動物公園        ／ 鹿児島市平川動物公園
#   吉野ヶ里歴史公園    ／ 国営吉野ヶ里歴史公園
#   天王寺動物園        ／ 大阪市天王寺動物園
#
# どちらの書き方も使われるので、出典が違うと両方入ります。
# 「町」「村」は、頭に付くと**ふつうの言葉の一部**であることが多いので、
# 「町立」「村立」の形でだけ採ります。
#
#   休暇村大久野島 ／ 大久野島   「休暇村」の村を行政の頭と読むと、
#                                 島とホテルが同じものになります
#
# 「市」「区」「県」「府」「都」「道」は、頭に来ればまず地名です。
ADMIN_HEAD = re.compile(
    r"^(国営|国立|県立|府立|都立|道立|市立|町立|村立|区立"
    r"|[^\s]{2,4}?[市区県府都道])")


def head_of(name):
    """空白・中黒で切った、最初のまとまり。無ければ None。

    **clean() は空白を消します。** それで揃うものが多いのですが、
    この空白は手がかりでもありました。

        京王高尾山温泉 極楽湯   ／ 京王高尾山温泉
        下関市立しものせき水族館 海響館 ／ 下関市立しものせき水族館
        唐戸市場・カモンワーフ  ／ 唐戸市場

    どれも同じ場所です。消してから比べると別物になり、**旅程が同じ
    温泉へ2回行きます**（実際に出ました）。

    くっついているものは切りません。「錦帯橋温泉」と「錦帯橋」は
    別物で、そこに空白はありません。空白があるかどうかが、
    「あだ名が付いている」と「別の名前」を分けています。
    """
    n = unicodedata.normalize("NFKC", name)
    n = re.sub(r"[（(].*?[)）]", "", n)
    bits = re.split(r"[\s　・]", n, 1)
    if len(bits) < 2:
        return None
    h = clean(bits[0])
    # 短すぎる頭は、たまたま一致します。
    return h if len(h) >= 3 else None


def without_admin(name):
    """行政の頭を外した形。外せなければ None。"""
    c = clean(name)
    m = ADMIN_HEAD.match(c)
    if not m or len(c) - m.end() < 3:
        return None
    return c[m.end():]


# あだ名・行政の頭の判定を使ってよい距離。
#
# **名前だけでは決められないからです。** 空白の後ろに付くものは、
# 同じ場所のあだ名のこともあれば、その中の特定の場所のこともあります。
#
#   京王高尾山温泉 極楽湯  ／ 京王高尾山温泉   0m     同じ
#   下関市立…水族館 海響館 ／ …水族館          0m     同じ
#   羽黒山 五重塔          ／ 羽黒山          818m   別（塔は塔）
#   富士山 吉田ルート登山道 ／ 富士山         1388m  別（道は道）
#   阿蘇山 中岳火口        ／ 阿蘇山         1844m  別（火口は火口）
#
# 名前の形は同じですが、意味が逆です。分けられるのは距離だけでした。
# 同じ建物なら座標はほぼ重なります。離れていれば、それは中の別の場所です。
NICKNAME_KM = 0.25

# 距離では分けられないので、**手で確かめた組**。
#
# 名前も距離も、この2つを分けてはくれませんでした。
#
#    418m  延岡城・内藤記念博物館 ／ 延岡城          別（城と、隣の館）
#    423m  京王高尾山温泉 極楽湯 ／ 京王高尾山温泉   同じ（座標が違うだけ）
#    512m  高鍋大師 持田古墳群 ／ 高鍋大師           別
#
# 閾値を 423m まで広げれば1つ目は通りますが、**法隆寺 i センターと
# 法隆寺（563m）、六甲山 天覧台と六甲山（736m）まで一緒にまとめます**。
# 規則を緩めて1件を通すより、確かめた1件を名指しするほうが正直です。
#
# 足すときは、両方の記事を実際に読んでからにしてください。
# **名前で持ちます。id ではありません。**
#
# はじめは id の組（"takao-5" と "wd-Q21018985"）にしていました。
# まとめられはするのですが、そのあと取り込みを走らせると**また入り
# ます**——取り込みが作る id は毎回変わるので、名指しが効きません。
# 実際に、まとめた直後の再取り込みで復活しました。
SAME_PLACE_NAMES = {
    # ja.wikipedia の「京王高尾山温泉」は極楽湯のことです（高尾山口駅
    # 直結の日帰り温泉）。収録に2つ入っていて、旅程が同じ湯へ2回
    # 行っていました。座標は423m食い違っています。
    frozenset({"京王高尾山温泉", "京王高尾山温泉極楽湯"}),
}
# 行政の頭（「鹿児島市」「県立」）のほうは、もう少し広く採ります。
# ただし**これも距離が要ります**——「大川町氷川神社」と「氷川神社」は
# 1.5km離れた別の神社でした。氷川神社はどこにでもあります。
ADMIN_KM = 0.4


def same_place(a, b, km_apart=None):
    """同じ場所か。

    `km_apart` を渡すと、名前だけでは決めきれない判定（あだ名・行政の
    頭）も使います。**渡さなければ使いません。** 名前が似ているだけの
    別の場所を、黙ってまとめないためです。
    """
    fa, ba, pa = parts(a["name"])
    fb, bb, pb = parts(b["name"])
    if fa == fb:
        return True
    if pa and pa == fb:
        return True
    if pb and pb == fa:
        return True
    if pa and not pb and ba == fb:
        return True
    if pb and not pa and bb == fa:
        return True
    # 手で確かめた組。名前でも距離でも分けられなかったものです。
    if frozenset({fa, fb}) in SAME_PLACE_NAMES:
        return True
    if km_apart is None:
        return False
    # あだ名が付いているだけのもの（ごく近いときだけ）。
    if km_apart <= NICKNAME_KM and (head_of(a["name"]) == fb
                                    or head_of(b["name"]) == fa):
        return True
    # 「市立」や「国営」が付いているだけのもの。
    if km_apart <= ADMIN_KM and (without_admin(a["name"]) == fb
                                 or without_admin(b["name"]) == fa):
        return True
    return False


def km(a, b):
    dy = (a["lat"] - b["lat"]) * 111
    dx = (a["lng"] - b["lng"]) * 111 * math.cos(math.radians(a["lat"]))
    return math.hypot(dx, dy)


def richness(s):
    """情報の多さ。まとめるときに、どちらを残すかの目安。"""
    n = 0
    n += min(len(s.get("description") or ""), 200)
    if s.get("verified"):
        n += 60
    if s.get("open") is not None and s.get("close") is not None:
        n += 40
    if s.get("fee") is not None:
        n += 20
    if s.get("wikipedia"):
        n += 20
    return n


def load():
    files = {}
    for path in sorted(glob.glob(os.path.join(WEB, "kb", "spots-*.json"))):
        with open(path, encoding="utf-8") as f:
            files[path] = json.load(f)
    return files


def find_pairs(files):
    spots = []
    for path, doc in files.items():
        for s in doc["spots"]:
            s["_path"] = path
            spots.append(s)

    grid = {}
    for s in spots:
        grid.setdefault((round(s["lat"] / 0.02), round(s["lng"] / 0.02)), []).append(s)

    pairs, seen = [], set()
    for (gx, gy), bucket in grid.items():
        near = [x for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                for x in grid.get((gx + dx, gy + dy), [])]
        for a in bucket:
            for b in near:
                if a["id"] >= b["id"] or (a["id"], b["id"]) in seen:
                    continue
                d = km(a, b)
                if not same_place(a, b, d):
                    continue
                if d <= MERGE_RADIUS_KM:
                    seen.add((a["id"], b["id"]))
                    pairs.append((a, b, d))
    return spots, sorted(pairs, key=lambda p: -p[2])


def main(write):
    files = load()
    spots, pairs = find_pairs(files)
    print(f"収録 {len(spots)}件 / 同一とみられる組 {len(pairs)}件")

    drop = set()
    conflicts = []
    for a, b, d in pairs:
        keep, gone = (a, b) if richness(a) >= richness(b) else (b, a)
        note = ""
        if d > CONFLICT_KM:
            key = (a["id"], b["id"])
            if key in CONFIRMED:
                # 確かめた座標を、残すほうへ移します。
                src = a if a["id"] == CONFIRMED[key] else b
                keep["lat"], keep["lng"] = src["lat"], src["lng"]
                note = f"座標は {src['id']} を採用"
            else:
                conflicts.append((a, b, d))
                note = "座標が食い違っています（要確認）"
        drop.add(gone["id"])
        print(f"  {d * 1000:5.0f}m  残す {keep['name']}[{keep['id']}]"
              f" / まとめる {gone['name']}[{gone['id']}] {note}")

    if conflicts:
        print(f"\n座標の食い違い {len(conflicts)}件。"
              "どちらが正しいか確かめて CONFIRMED に足してください:")
        for a, b, d in conflicts:
            print(f"  {d * 1000:5.0f}m  (\"{a['id']}\", \"{b['id']}\")"
                  f"  {a['name']} / {b['name']}")

    if not write:
        print("\n--write を付けると書き戻します。")
        return

    per_region = {}
    total = 0
    for path, doc in files.items():
        before = len(doc["spots"])
        doc["spots"] = [s for s in doc["spots"] if s["id"] not in drop]
        for s in doc["spots"]:
            s.pop("_path", None)
            per_region[s["regionId"]] = per_region.get(s["regionId"], 0) + 1
        total += len(doc["spots"])
        if len(doc["spots"]) != before:
            print(f"{os.path.basename(path)}: {before} → {len(doc['spots'])}")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))

    # 件数は3か所に書いてあります。片方だけ直すと、画面の数と中身が
    # 食い違ったまま気づけません。
    rpath = os.path.join(WEB, "kb", "regions.json")
    with open(rpath, encoding="utf-8") as f:
        regions = json.load(f)
    for r in regions["regions"]:
        if "spotCount" in r:
            r["spotCount"] = per_region.get(r["id"], 0)
    with open(rpath, "w", encoding="utf-8") as f:
        json.dump(regions, f, ensure_ascii=False, separators=(",", ":"))

    ipath = os.path.join(WEB, "kb", "index.json")
    with open(ipath, encoding="utf-8") as f:
        index = json.load(f)
    by_file = {os.path.basename(p): len(d["spots"]) for p, d in files.items()}
    for shard in index.get("shards", []):
        if shard["file"] in by_file:
            shard["count"] = by_file[shard["file"]]
    if "counts" in index:
        index["counts"]["spots"] = total
    with open(ipath, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    print(f"\n{len(drop)}件をまとめました（収録 {total}件）。")


if __name__ == "__main__":
    main(write="--write" in sys.argv)
