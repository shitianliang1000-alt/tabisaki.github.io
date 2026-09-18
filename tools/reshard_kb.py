#!/usr/bin/env python3
# coding: utf-8
"""収録スポットを、都道府県ごとのシャードに並べ替える。
#
#     python3 tools/reshard_kb.py [kb ディレクトリ]
#
# なぜ並べ替えるのか
# ------------------
# シャードは**出典ごと**に切られていました（国土数値情報、Wikidata）。
# 出典は読む側にとって何の意味もない切り方なので、「島根の旅程を組む」
# ためにも 4.8MB（gzip で約1MB）を全部読むことになります。
#
# 都道府県ごとに切り直すと、地名の書かれた希望では、その県のぶんだけで
# 足ります（島根県なら 100KB ほど、gzip で 25KB ほど）。行き先の
# 絞り込み（js/pipeline.js の scope）は、地名から**エリアの一覧**だけで
# 決まるので、スポットはそのあとで足ります。
#
# 何を守るか
# ----------
#   ・件数は1件も変えません（入れ替えるのは入れ物だけです）
#   ・出典（dataSource）が段の側に書かれていたものは、スポットに移します
#     （並べ替えると、1つの段に複数の出典が混ざるためです）
#   ・index.json には、段ごとに「どのエリアが入っているか」を書きます
#     （読む側が、必要な段だけを選べるようにするためです）
#
# 地名の索引（names.json）
# ------------------------
# 「収録に無い土地」の判定（js/areas.js の unknownPlaceTerms）は、
# スポットの名前を全部つないだ文字列に対する部分一致で行っています。
# 段を遅れて読むと、読んでいない県の場所が「収録に無い」と判定されて
# しまうので、**名前だけ**を別に出しておきます（gzip で100KB ほど）。
"""

import io
import json
import os
import re
import sys

# 都道府県の番号（JIS X 0401）。ファイル名を安定させるために使います。
PREFS = [
    ("北海道", "01", "hokkaido"), ("青森県", "02", "aomori"),
    ("岩手県", "03", "iwate"), ("宮城県", "04", "miyagi"),
    ("秋田県", "05", "akita"), ("山形県", "06", "yamagata"),
    ("福島県", "07", "fukushima"), ("茨城県", "08", "ibaraki"),
    ("栃木県", "09", "tochigi"), ("群馬県", "10", "gunma"),
    ("埼玉県", "11", "saitama"), ("千葉県", "12", "chiba"),
    ("東京都", "13", "tokyo"), ("神奈川県", "14", "kanagawa"),
    ("新潟県", "15", "niigata"), ("富山県", "16", "toyama"),
    ("石川県", "17", "ishikawa"), ("福井県", "18", "fukui"),
    ("山梨県", "19", "yamanashi"), ("長野県", "20", "nagano"),
    ("岐阜県", "21", "gifu"), ("静岡県", "22", "shizuoka"),
    ("愛知県", "23", "aichi"), ("三重県", "24", "mie"),
    ("滋賀県", "25", "shiga"), ("京都府", "26", "kyoto"),
    ("大阪府", "27", "osaka"), ("兵庫県", "28", "hyogo"),
    ("奈良県", "29", "nara"), ("和歌山県", "30", "wakayama"),
    ("鳥取県", "31", "tottori"), ("島根県", "32", "shimane"),
    ("岡山県", "33", "okayama"), ("広島県", "34", "hiroshima"),
    ("山口県", "35", "yamaguchi"), ("徳島県", "36", "tokushima"),
    ("香川県", "37", "kagawa"), ("愛媛県", "38", "ehime"),
    ("高知県", "39", "kochi"), ("福岡県", "40", "fukuoka"),
    ("佐賀県", "41", "saga"), ("長崎県", "42", "nagasaki"),
    ("熊本県", "43", "kumamoto"), ("大分県", "44", "oita"),
    ("宮崎県", "45", "miyazaki"), ("鹿児島県", "46", "kagoshima"),
    ("沖縄県", "47", "okinawa"),
]
BY_NAME = {name: (code, slug) for name, code, slug in PREFS}

# 地名らしい語尾。js/areas.js の PLACE_SUFFIX と同じ並びです。
# （同じものを2か所に書いていますが、こちらは**広めに拾う**ためのもの
#   なので、少しずれても害はありません。多めに拾えば「収録に無い」と
#   誤って言うことが減るだけです。）
PLACE_SUFFIX = ("島|山|岳|丘|砂丘|川|湖|沼|岬|崎|温泉|寺|神社|宮|城|園|峠|渓|滝"
                "|浜|浦|坂|橋|塔|宿|村|町|市|郡|県|府|地方|高原|海岸|渓谷|半島"
                "|平野|盆地|遺跡|城跡")
PLACE_RE = re.compile(
    r"[一-龥ぁ-んァ-ヶー々〆ヵヶA-Za-z0-9]{1,12}(?:" + PLACE_SUFFIX + r")")


def load(kb_dir):
    with io.open(os.path.join(kb_dir, "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    with io.open(os.path.join(kb_dir, "regions.json"), encoding="utf-8") as f:
        regions = json.load(f)["regions"]

    spots = []
    for shard in index["shards"]:
        path = os.path.join(kb_dir, shard["file"])
        with io.open(path, encoding="utf-8") as f:
            doc = json.load(f)
        # 出典が段の側にまとめて書かれていることがあります。並べ替えると
        # 1つの段に複数の出典が混ざるので、スポットに移します。
        from_doc = doc.get("dataSource")
        for spot in doc.get("spots", []):
            if from_doc and "dataSource" not in spot:
                spot["dataSource"] = from_doc
            spots.append(spot)
    return index, regions, spots


def prefecture_of(spot, region_by_id):
    pref = spot.get("prefecture")
    if not pref:
        region = region_by_id.get(spot.get("regionId"))
        pref = (region or {}).get("prefecture")
    return pref or ""


def write(kb_dir, index, regions, spots):
    dump = lambda obj: json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    region_by_id = {r["id"]: r for r in regions}

    groups = {}
    for spot in spots:
        pref = prefecture_of(spot, region_by_id)
        code, slug = BY_NAME.get(pref, ("00", "other"))
        groups.setdefault((code, slug, pref), []).append(spot)

    # 古い段を消します。残すと、読む側が両方を読んで件数が倍になります。
    for name in os.listdir(kb_dir):
        if name.startswith("spots-") and name.endswith(".json"):
            os.remove(os.path.join(kb_dir, name))

    shards = []
    for (code, slug, pref) in sorted(groups):
        part = groups[(code, slug, pref)]
        fn = "spots-jp%s-%s.json" % (code, slug)
        with io.open(os.path.join(kb_dir, fn), "w", encoding="utf-8") as f:
            f.write(dump({"spots": part}))
        shards.append({
            "file": fn,
            "count": len(part),
            "prefecture": pref,
            # その段に入っているエリア。読む側は、ここを見て段を選びます。
            "regions": sorted({s["regionId"] for s in part if s.get("regionId")}),
        })

    index["shards"] = shards
    index["counts"] = {"regions": len(regions), "spots": len(spots)}
    with io.open(os.path.join(kb_dir, "index.json"), "w", encoding="utf-8") as f:
        f.write(dump(index))

    # 地名の索引。名前と、説明の中の地名らしい語をつなぎます。
    names = []
    seen = set()
    for spot in spots:
        name = spot.get("name") or ""
        if name and name not in seen:
            seen.add(name)
            names.append(name)
    # 説明の中の地名らしい語も入れていました。ただ、それだけで 460KB
    # 増えます（gzip でも 170KB）。説明は住所と短い一文がほとんどで、
    # そこにしか出てこない地名を打たれることは稀です。外したときに
    # 起きるのは「その語を調べにいく」だけなので、軽いほうを採ります。
    with io.open(os.path.join(kb_dir, "names.json"), "w", encoding="utf-8") as f:
        f.write(dump({"names": "\n".join(names)}))

    total = sum(os.path.getsize(os.path.join(kb_dir, f))
                for f in os.listdir(kb_dir))
    sys.stderr.write(
        "%d 段 / %d エリア / %d スポット / %.1f MB\n"
        % (len(shards), len(regions), len(spots), total / 1048576))
    biggest = sorted(shards, key=lambda s: s["count"], reverse=True)[:3]
    for s in biggest:
        size = os.path.getsize(os.path.join(kb_dir, s["file"])) / 1024
        sys.stderr.write("  %s %d件 %.0fKB\n" % (s["prefecture"], s["count"], size))


def main():
    kb_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "kb")
    index, regions, spots = load(kb_dir)
    before = len(spots)
    write(kb_dir, index, regions, spots)
    # 件数が変わっていたら、入れ物ではなく中身を触っています。
    after = sum(s["count"] for s in json.load(
        io.open(os.path.join(kb_dir, "index.json"), encoding="utf-8"))["shards"])
    if before != after:
        raise SystemExit("件数が変わりました: %d → %d" % (before, after))


if __name__ == "__main__":
    main()
