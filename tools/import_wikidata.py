# -*- coding: utf-8 -*-
"""Wikidata から、日本の行き先を足す。

**なぜ Wikidata なのか。** 収録を厚くする道はいくつもありましたが、
公開リポジトリに置ける（＝再配布してよいことがはっきりしている）ものは
多くありません。

    国土数値情報 P33 集客施設 / P32 都道府県指定文化財   非商用のみ・再配布不可 → 使わない
    OpenStreetMap                                       ODbL（継承義務）    → 使わない
    Wikidata                                            CC0                → これを使う

CC0 は「権利を手放してある」ので、条件はありません。

**質のそろえ方。** Wikidata には日本の神社が16,500件ありますが、その多くは
名前と座標だけの点です。旅程に出しても、行った人が困ります。そこで
**日本語版ウィキペディアに記事があるものだけ**を取ります（SPARQL の
`?a schema:about ?x ; schema:isPartOf <https://ja.wikipedia.org/>`）。
記事があるということは、少なくとも誰かが書くに値すると判断した場所です。
これで神社は 16,500 → 5,673 件になります。

取り込みの決まりは tools/import_csv.py と同じです。

    ・すでに収録にある場所（近くて名前が似ている）は足しません
    ・同じエリアに同じ名前がすでにあるものは足しません
    ・置き場所（エリア）が遠すぎるものは足しません
    ・src="wikidata" を付けます。まとめて外したくなったときのためです

**多すぎる分をどう削るか。** 記事のあるものだけに絞っても38,000件あり、
全部入れると収録が5万件を超えます。読み込みが重くなるだけでなく、
候補が薄まって、AIに渡す一覧が「聞いたこともない神社」で埋まります。

そこで **他言語版を含めたウィキペディアの記事数（sitelinks）** の多い順に
採ります。何か国語で書かれているかは、その場所がどれだけ広く知られて
いるかの、そこそこ正直な代わりになります。同じ数字で、収録の
fame_tier（定番か穴場か）も決めています。

    python3 tools/import_wikidata.py --check   確認するだけ
    python3 tools/import_wikidata.py --write   足して書き戻す

元データの取り方は tools/fetch_wikidata.py を見てください。
"""
import collections
import glob
import json
import math
import os
import sys

from dedupe_spots import same_place
from landmarks import pick_region

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
RAW = os.path.join(WEB, "data", "wikidata")

SRC = "wikidata"

# エリアの代表点からこれ以上離れていたら、置き場所が無いと見なします。
# 近いエリアが1つも無い土地（離島や山の中）に無理に置くと、旅程の
# 移動時間がそのぶんまるごと狂います。
MAX_REGION_KM = 30.0

# 収録全体の目安。これに届くところまで、記事数の多い順に採ります。
TARGET_TOTAL = 30000

# 記事数（sitelinks）から、定番/穴場を決める境目。日本語版にしか記事が
# 無い場所は穴場、何か国語かで書かれていれば知られた場所、という見方です。
TIER_MAJOR = 15
TIER_KNOWN = 5

# Wikidata の分類 → 収録の分類。収録側にある名前に寄せます。新しい名前を
# 作ると、滞在時間もジャンルも既定値になって、どれも同じ扱いになります。
CLASSES = {
    "Q845945": "神社",
    "Q5393308": "寺院",
    "Q8502": "山",
    "Q22698": "公園",
    "Q33506": "博物館",
    "Q655311": "温泉",
    "Q23413": "城",
    "Q39715": "灯台",
    "Q34038": "滝",
    "Q23397": "湖",
    "Q93352": "海岸",
    "Q185113": "岬",
    "Q23442": "島",
    "Q133056": "峠",
    "Q15835": "庭園",
    "Q43501": "動物園",
    "Q2281788": "水族館",
    "Q194195": "遊園地",
    "Q177305": "展望台",
    "Q1081138": "史跡",
    "Q11414752": "名勝",
    "Q4946461": "温泉",
    "Q12323": "ダム",
    "Q35509": "洞窟",
    "Q34651": "教会",
    "Q21000333": "商店街",
}

# 分類の優先順。同じ場所が複数の分類に出てきたとき（温泉街でもあり
# 温泉でもある、など）、こちらを先に採ります。狭いほうが説明として
# 役に立つので、狭い分類を上に置いています。
PRIORITY = ["温泉", "城", "水族館", "動物園", "遊園地", "庭園", "展望台",
            "灯台", "ダム", "道の駅", "商店街", "教会", "神社", "寺院",
            "博物館", "名勝", "史跡", "滝", "洞窟", "峠", "岬", "海岸",
            "湖", "島", "山", "公園"]

SOURCE_LINKS = [
    {"name": "Wikidata（CC0）", "url": "https://www.wikidata.org/"},
]


def tier(sitelinks):
    if sitelinks >= TIER_MAJOR:
        return "major"
    if sitelinks >= TIER_KNOWN:
        return "known"
    return "hidden"


def km(a_lat, a_lng, b_lat, b_lng):
    dy = (a_lat - b_lat) * 111.0
    dx = (a_lng - b_lng) * 111.0 * math.cos(math.radians((a_lat + b_lat) / 2))
    return math.hypot(dx, dy)


def load_shards():
    out = {}
    for path in sorted(glob.glob(os.path.join(WEB, "kb", "spots-*.json"))):
        with open(path, encoding="utf-8") as f:
            out[path] = json.load(f)
    return out


def read_raw():
    """data/wikidata/wd-*.json を読み、1件1分類にまとめます。"""
    best = {}
    order = {c: i for i, c in enumerate(PRIORITY)}
    for path in sorted(glob.glob(os.path.join(RAW, "wd-*.json"))):
        qid = os.path.basename(path)[3:-5]
        category = CLASSES.get(qid)
        if not category:
            continue
        with open(path, encoding="utf-8") as f:
            for row in json.load(f):
                cur = best.get(row["q"])
                rank = order.get(category, 99)
                if cur and order.get(cur["category"], 99) <= rank:
                    continue
                best[row["q"]] = dict(row, category=category)
    return list(best.values())


# 分類には合っているのに、行き先にはならないもの。座標は1点ですが、
# 実体は国であったり、県をまたぐ地域であったりします。「本州」を
# 1か所として旅程に入れると、滞在90分の予定が立ちます。
TOO_BIG = {"日本", "本州", "北海道", "九州", "四国", "沖縄本島"}

# 名前で落とすもの。
#   国立公園・国定公園・県立自然公園  … 数十kmの範囲で、1点にはなりません
#   遺産群                            … 複数の資産をまとめた登録名です
#   空港・駅・インターチェンジ        … 行き先ではなく、通り道です
BAD_SUFFIX = ("国立公園", "国定公園", "自然公園", "空港", "飛行場",
              "インターチェンジ")
BAD_PART = ("遺産群",)


def looks_unusable(row):
    """名前が使いものにならない行。旅程に出しても、どこだか分かりません。"""
    name = row["name"].strip()
    if name in TOO_BIG:
        return True
    if name.endswith(BAD_SUFFIX) or any(b in name for b in BAD_PART):
        return True
    if not name or len(name) < 2:
        return True
    # ラベルが Q番号のままのもの、緯度経度が日本の外のもの。
    if name.startswith("Q") and name[1:].isdigit():
        return True
    if not (20.0 <= row["lat"] <= 46.5 and 122.0 <= row["lng"] <= 154.0):
        return True
    return False


def main(write):
    rows = [r for r in read_raw() if not looks_unusable(r)]
    # 記事数の多い順。同数のときは名前の順にして、走らせるたびに
    # 中身が入れ替わらないようにします。
    rows.sort(key=lambda r: (-r.get("sl", 0), r["name"]))
    print(f"Wikidata {len(rows)}件（日本語版ウィキペディアに記事があるもの）")

    shards = load_shards()
    existing = [s for doc in shards.values() for s in doc["spots"]]
    with open(os.path.join(WEB, "kb", "regions.json"), encoding="utf-8") as f:
        regions = json.load(f)

    # 近いものだけ突き合わせます。全件どうしを比べると数億回になり、
    # しかも遠くの同名（「白山神社」など）を同じものにしてしまいます。
    grid = collections.defaultdict(list)
    for s in existing:
        grid[(round(s["lat"] / 0.05), round(s["lng"] / 0.05))].append(s)

    # 座標が離れていても、同じエリアに同じ名前が2つあるのは困ります。
    # 「横山ダム」は堤体と資料館で座標がずれていますが、旅程に2行
    # 並べば、読むほうには同じ場所が2回出ているようにしか見えません。
    named = {(s["regionId"], s["name"]) for s in existing}

    room = TARGET_TOTAL - len(existing)
    add, skip, orphan = [], [], []
    for r in rows:
        if len(add) >= room:
            break
        probe = {"name": r["name"], "lat": r["lat"], "lng": r["lng"]}
        gx, gy = round(r["lat"] / 0.05), round(r["lng"] / 0.05)
        near = [x for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                for x in grid[(gx + dx, gy + dy)]]
        if any(same_place(probe, s) for s in near):
            skip.append(r["name"])
            continue
        region = pick_region(regions["regions"], r["lat"], r["lng"], "")
        if region and (region["id"], r["name"]) in named:
            skip.append(r["name"])
            continue
        if not region or km(r["lat"], r["lng"],
                            region["lat"], region["lng"]) > MAX_REGION_KM:
            orphan.append(r["name"])
            continue
        spot = {
            "id": f"wd-{r['q']}",
            "regionId": region["id"],
            "name": r["name"],
            "category": r["category"],
            "lat": round(r["lat"], 5),
            "lng": round(r["lng"], 5),
            "fame_tier": tier(r.get("sl", 0)),
            "src": SRC,
        }
        add.append(spot)
        grid[(gx, gy)].append(spot)
        named.add((region["id"], r["name"]))

    by_cat = collections.Counter(s["category"] for s in add)
    by_tier = collections.Counter(s["fame_tier"] for s in add)
    print("  " + " / ".join(f"{k} {v}件" for k, v in by_tier.most_common()))
    print(f"足す {len(add)}件 / すでにある {len(skip)}件"
          f" / 置き場所が無い {len(orphan)}件")
    for cat, n in by_cat.most_common():
        print(f"  {cat} {n}件")

    if not write:
        print("\n--write を付けると書き戻します。")
        return

    # 1ファイルが大きすぎると、読み込みの途中経過が出せません。段に
    # 分けて足します（kb.js は index.json の shards を順に読みます）。
    per_file = 2500
    chunks = [add[i:i + per_file] for i in range(0, len(add), per_file)]
    for n, chunk in enumerate(chunks):
        path = os.path.join(WEB, "kb", f"spots-wd{n:02d}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"spots": chunk}, f, ensure_ascii=False,
                      separators=(",", ":"))
        shards[path] = {"spots": chunk}

    per_region, total = {}, 0
    for doc in shards.values():
        total += len(doc["spots"])
        for s in doc["spots"]:
            per_region[s["regionId"]] = per_region.get(s["regionId"], 0) + 1
    for reg in regions["regions"]:
        if "spotCount" in reg:
            reg["spotCount"] = per_region.get(reg["id"], 0)
    with open(os.path.join(WEB, "kb", "regions.json"), "w",
              encoding="utf-8") as f:
        json.dump(regions, f, ensure_ascii=False, separators=(",", ":"))

    ipath = os.path.join(WEB, "kb", "index.json")
    with open(ipath, encoding="utf-8") as f:
        index = json.load(f)
    have_file = {s["file"] for s in index.get("shards", [])}
    for path, doc in sorted(shards.items()):
        name = os.path.basename(path)
        if name in have_file:
            for s in index["shards"]:
                if s["file"] == name:
                    s["count"] = len(doc["spots"])
        else:
            index["shards"].append({"file": name, "count": len(doc["spots"])})
    if "counts" in index:
        index["counts"]["spots"] = total
    have = {s["name"] for s in index.get("sources", [])}
    index["sources"] = index.get("sources", []) + [
        s for s in SOURCE_LINKS if s["name"] not in have]
    with open(ipath, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    print(f"\n収録 {total}件になりました。")


if __name__ == "__main__":
    main(write="--write" in sys.argv)
