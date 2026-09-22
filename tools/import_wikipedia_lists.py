# -*- coding: utf-8 -*-
"""ウィキペディアの一覧記事から集めた場所を、収録に足す。

素データは tools/fetch_wikipedia_lists.py が data/wikipedia/ に落として
います。ここは**足すかどうかを決めて、書き戻す**だけです。

なぜ一覧記事なのか
------------------
収録はすでに Wikidata から3万件ほど入っています。ただし Wikidata は
**分類（P31）が付いているものしか引けません**。日本の場所には、分類が
無い・粗い記事が相当あります（古墳、峠、渓谷、用水路）。

日本語版ウィキペディアの一覧記事は、その分野に詳しい人が「これは
載せる」と判断した結果です。分類より粗いぶん、**判断が入っています**。

足す決まり（tools/import_wikidata.py と同じ）
----------------------------------------------
  ・すでに収録にある場所（近くて名前が似ている）は足しません
  ・同じエリアに同じ名前がすでにあるものは足しません
  ・置き場所（エリア）が遠すぎるものは足しません
  ・src="wikipedia" を付けます。まとめて外したくなったときのためです

定番か穴場か
------------
Wikidata から入れたものは、他言語版の記事数（sitelinks）で決めています。
ウィキペディアの一覧記事には、その数字がありません。

**無い数字を作りません。** 代わりに、手元にある数で決めます——
**いくつの一覧に載っているか**です。「清水寺」は日本の観光地一覧にも
京都府の観光地にも日本の寺院一覧にも出てきますが、名もない峠は1つの
一覧にしか出てきません。どれだけ広く「載せるに値する」と見なされて
いるかの、そこそこ正直な代わりになります。

出典
----
収録には Wikipedia とだけ書きます（記事名は wikipedia 欄に入るので、
そこから記事へたどれます）。

    python3 tools/import_wikipedia_lists.py --check   確認するだけ
    python3 tools/import_wikipedia_lists.py --write   足して書き戻す
"""
import collections
import glob
import hashlib
import json
import math
import os
import re
import sys

from dedupe_spots import same_place
from landmarks import pick_region

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
RAW = os.path.join(WEB, "data", "wikipedia")

SRC = "wikipedia"

# エリアの代表点からこれ以上離れていたら、置き場所が無いと見なします。
MAX_REGION_KM = 30.0

# 分類の優先順。同じ場所が複数の一覧に出てきたとき、狭いほうを採ります
# （「清水寺」は観光地一覧にも寺院一覧にも出ます。寺院のほうが、旅程の
#  説明として役に立ちます）。
PRIORITY = ["温泉", "スキー場", "海水浴場", "庭園", "城", "神社", "寺院",
            "建築", "史跡", "渓谷", "峠", "滝", "川", "湖", "島", "山",
            "公園", "観光名所"]

# いくつの一覧に載っていたら、定番／知られた場所とするか。
TIER_MAJOR = 3
TIER_KNOWN = 2

SOURCE_LINKS = [
    {"name": "Wikipedia", "url": "https://ja.wikipedia.org/"},
]

# 説明に使う長さ。旅程の1行に収まるところまでです。
DESC_MAX = 90


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


# 分類には合っているのに、行き先にはならないもの。
TOO_BIG = {"日本", "本州", "北海道", "九州", "四国", "沖縄本島",
           "日本列島", "東北地方", "関東地方", "中部地方", "近畿地方",
           "中国地方", "九州地方"}

# 名前で落とすもの。
#   一覧・カテゴリ            … 記事であって場所ではありません
#   国立公園・国定公園        … 数十kmの範囲で、1点にはなりません
#   空港・駅・インターチェンジ … 行き先ではなく、通り道です
#   都道府県・市区町村        … 広すぎます（「京都市 90分」は立ちません）
#   山地・山脈・湾・半島ほか  … 同じ理由です。下に書きました
#
# 「1点にならないもの」を落とすのは、国立公園と同じ理屈です。
#
#   東京湾    ふちの長さが数百kmあります
#   飛騨山脈  北アルプス。100km以上に伸びています
#   伊豆半島  縦に50km、宿も駅もいくつもあります
#   五島列島  島が150ほどあり、渡るのに船が要ります
#
# どれも座標は付いていますが、それは**代表点**です。旅程に
# 「東京湾 45分」と出しても、どこへ行けばいいのか分かりません。
# 行き先になるのは、その中の海岸や展望台や島のほうで、そちらは
# 別の記事として収録に入っています。
#
# 小さな湾（英虞湾・館山湾）も落ちます。惜しいのですが、大きさで
# 線を引けません——**どこまでが「立てる場所」かは、記事名からは
# 分かりません**。分からないものを入れて、当たっていることを期待する
# よりは、落とすほうを選びます。
BAD_SUFFIX = ("一覧", "国立公園", "国定公園", "自然公園", "空港", "飛行場",
              "インターチェンジ", "都道府県", "地方", "県", "府", "都",
              "市", "区", "町", "村", "郡",
              "山地", "山脈", "山塊", "平野", "盆地", "台地", "半島",
              "諸島", "列島", "地域", "海峡", "湾", "流域", "水系")
BAD_PART = ("遺産群", "の一覧", "Category:", "Template:", "Portal:")

# 施設ではあるけれど、行き先にはならないもの。
#
# 一覧記事は、本題のついでに近所のものへも大量にリンクします。渓谷の
# 一覧から中学校へ、植物園の一覧から大学へ。座標も分類も付いてしまうので
# 名前で落とします。書き出したものを無作為に見て、見つけたぶんです。
#
#   松山大学            → 公園
#   宇和島市立宇和海中学校 → 渓谷
#   西条市立周桑病院      → 渓谷
#
# 「旧」で始まるものは残します（旧岩谷堂共立病院のように、保存された
# 建物が別の名前を持たないまま載っていることがあります）。
NOT_A_DESTINATION = ("大学", "大学校", "高等学校", "高校", "中学校",
                     "小学校", "専門学校", "病院", "銀行", "放送局",
                     "株式会社", "信用金庫")

# 場所ではなく、催しの名前。
#
# 「岩国行波の神舞」「木幡の幡祭り」。観光地の一覧には、その土地の祭りが
# 当たり前に並びます。座標（神社）も付きます。けれど**旅程に入れられる
# ものではありません**——開かれるのは年に1日か2日で、日付は毎年変わり、
# この収録はその日付を持っていません。
#
# js/events.js でも同じ判断をしています（個別の催しの日程は持たない）。
# 持てば必ず古くなり、古い日程を自信ありげに出すのは、何も言わないより
# 悪いためです。
AN_EVENT = ("舞", "祭", "祭り", "まつり", "踊り", "行事", "神事")

# 名前から分かる分類の直し。
#
# 分類は「その場所が載っていた一覧」から採ります。ところが一覧どうしは
# 重なるので、**橋が島の一覧から拾われる**ことがありました（呼子大橋は
# 加部島の記事から張られています）。64件ありました。
#
#   呼子大橋 → 島
#   音戸大橋 → 島
#
# 橋は橋です。名前で分かるものは、名前を先に見ます。
BY_NAME = ((("橋", "大橋"), "建築"),)


def category_of(name, from_list):
    """名前から分かる分類を、一覧より先に採ります。

    分類は「その場所が載っていた一覧」から採るのが基本です。ところが
    一覧どうしは重なるので、**橋が島の一覧から拾われました**（呼子大橋は
    加部島の記事から張られています）。橋は橋です。
    """
    for suffixes, cat in BY_NAME:
        if name.endswith(suffixes):
            return cat
    return from_list


def looks_unusable(name, lat, lng):
    name = (name or "").strip()
    if not name or len(name) < 2 or name in TOO_BIG:
        return True
    if name.endswith(BAD_SUFFIX) or any(b in name for b in BAD_PART):
        return True
    # 施設ではあるけれど、行き先にはならないもの。「旧」で始まるものは
    # 保存された建物のことがあるので残します。
    if name.endswith(NOT_A_DESTINATION) and not name.startswith("旧"):
        return True
    # 催しの名前。この収録は日付を持っていないので、旅程に入れられません。
    if name.endswith(AN_EVENT):
        return True
    # 曖昧さ回避や、年・分野の記事。
    if re.search(r"[（(](曖昧さ回避|人名|企業)[)）]", name):
        return True
    if not (20.0 <= lat <= 46.5 and 122.0 <= lng <= 154.0):
        return True
    return False


def describe(extract):
    """冒頭の文を、旅程の1行に収まる長さへ。

    **途中で切りません。** 「〜である。」で終わるところまでを採り、
    収まらなければ何も書きません。半端に切れた文は、読んだ人に
    「続きがある」と思わせるだけです。
    """
    text = re.sub(r"\s+", " ", (extract or "")).strip()
    if not text:
        return ""
    # 読み（ふりがな）の括弧は落とします。「清水寺（きよみずでら）は、」
    text = re.sub(r"[（(][ぁ-ゟー・\s]+[)）]", "", text)
    out = []
    for sentence in re.findall(r"[^。]*。", text):
        if len("".join(out)) + len(sentence) > DESC_MAX:
            break
        out.append(sentence)
    return "".join(out).strip()


def read_raw():
    """一覧（links-*.json）と、題→座標の控え（places.json）を突き合わせます。

    一覧には題しか入っていません。座標は控えのほうにあります。
    **控えに無い題は飛ばします**（座標を引けていない＝まだ聞いていないか、
    そもそも場所ではない、のどちらかです）。
    """
    cache_path = os.path.join(RAW, "places.json")
    if not os.path.exists(cache_path):
        raise SystemExit("data/wikipedia/places.json がありません"
                         "（先に tools/fetch_wikipedia_lists.py を走らせて"
                         "ください）")
    with open(cache_path, encoding="utf-8") as f:
        cache = json.load(f)

    order = {c: i for i, c in enumerate(PRIORITY)}
    best = {}
    seen_in = collections.Counter()
    for path in sorted(glob.glob(os.path.join(RAW, "links-*.json"))):
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        category = doc.get("category") or "観光名所"
        rank = order.get(category, 99)
        for title in doc.get("titles", []):
            place = cache.get(title)
            if not place:
                continue
            seen_in[title] += 1
            cur = best.get(title)
            if cur and order.get(cur["category"], 99) <= rank:
                continue
            best[title] = {
                "title": place.get("title", title), "category": category,
                "lat": place["lat"], "lng": place["lng"],
                "extract": place.get("extract", ""),
            }
    for title, row in best.items():
        row["lists"] = seen_in[title]
    return list(best.values())


def tier(lists):
    if lists >= TIER_MAJOR:
        return "major"
    if lists >= TIER_KNOWN:
        return "known"
    return "hidden"


def spot_id(title):
    """安定した id。記事名そのものは記号が混ざるので、短く潰します。"""
    h = hashlib.sha1(title.encode("utf-8")).hexdigest()[:10]
    return f"wp-{h}"


def main(write):
    rows = [r for r in read_raw()
            if not looks_unusable(r["title"], r["lat"], r["lng"])]
    # 多く載っている順。同数なら名前の順にして、走らせるたびに中身が
    # 入れ替わらないようにします。
    rows.sort(key=lambda r: (-r["lists"], r["title"]))
    print(f"ウィキペディアの一覧から {len(rows)}件（座標あり・場所らしいもの）")

    shards = load_shards()
    # **前回ここが書いたぶんは、「すでにある」に数えません。**
    #
    # 数えると、2回目の --write は全部を重複として弾き、spots-wp*.json が
    # 空になります。説明をあとから足す（--extracts のあと、もう一度
    # --write する）のがふつうの使い方なので、これは必ず起きます。
    #
    # spots-wp*.json は毎回いちから書き直すので、前回のぶんを外して
    # 考えるのが正しい形です。外したうえで、新しいぶんどうしの重なりは
    # 下の grid で見ます。
    existing = [s for doc in shards.values() for s in doc["spots"]
                if s.get("src") != SRC]
    mine = sum(1 for doc in shards.values() for s in doc["spots"]
               if s.get("src") == SRC)
    if mine:
        print(f"  （前回ここが入れた {mine}件 は、数え直します）")
    with open(os.path.join(WEB, "kb", "regions.json"), encoding="utf-8") as f:
        regions = json.load(f)

    grid = collections.defaultdict(list)
    for s in existing:
        grid[(round(s["lat"] / 0.05), round(s["lng"] / 0.05))].append(s)
    named = {(s["regionId"], s["name"]) for s in existing}

    add, skip, orphan = [], [], []
    for r in rows:
        probe = {"name": r["title"], "lat": r["lat"], "lng": r["lng"]}
        gx, gy = round(r["lat"] / 0.05), round(r["lng"] / 0.05)
        near = [x for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                for x in grid[(gx + dx, gy + dy)]]
        # 距離も渡します。**渡さないと、あだ名の判定が効きません**
        # （「京王高尾山温泉 極楽湯」と「京王高尾山温泉」が別物に
        # なります）。逆に渡しすぎても困るので、判定の側が距離で
        # 線を引いています（dedupe_spots.NICKNAME_KM）。
        if any(same_place(probe, s, km(probe["lat"], probe["lng"],
                                       s["lat"], s["lng"])) for s in near):
            skip.append(r["title"])
            continue
        region = pick_region(regions["regions"], r["lat"], r["lng"], "")
        if region and (region["id"], r["title"]) in named:
            skip.append(r["title"])
            continue
        if not region or km(r["lat"], r["lng"],
                            region["lat"], region["lng"]) > MAX_REGION_KM:
            orphan.append(r["title"])
            continue
        spot = {
            "id": spot_id(r["title"]),
            "regionId": region["id"],
            "name": r["title"],
            "category": category_of(r["title"], r["category"]),
            "lat": round(r["lat"], 5),
            "lng": round(r["lng"], 5),
            "fame_tier": tier(r["lists"]),
            "wikipedia": r["title"],
            "src": SRC,
        }
        desc = describe(r["extract"])
        if desc:
            spot["description"] = desc
        add.append(spot)
        grid[(gx, gy)].append(spot)
        named.add((region["id"], r["title"]))

    by_cat = collections.Counter(s["category"] for s in add)
    by_tier = collections.Counter(s["fame_tier"] for s in add)
    has_desc = sum(1 for s in add if s.get("description"))
    print("  " + " / ".join(f"{k} {v}件" for k, v in by_tier.most_common()))
    print(f"足す {len(add)}件（説明つき {has_desc}件）"
          f" / すでにある {len(skip)}件 / 置き場所が無い {len(orphan)}件")
    for cat, n in by_cat.most_common():
        print(f"  {cat} {n}件")

    # 説明をどの題に聞けばいいかを、書き出しておきます。
    #
    # 説明（冒頭2文）は配布ファイルからは取れないので API で聞きますが、
    # **足すと決まったものだけ**にします。3万件ぜんぶ聞くと600回になり、
    # 429 で断られ始めます。足すのが千件なら、20回で済みます。
    want = os.path.join(RAW, "want-extracts.json")
    os.makedirs(RAW, exist_ok=True)
    with open(want, "w", encoding="utf-8") as f:
        json.dump([s["name"] for s in add], f, ensure_ascii=False)
    missing = sum(1 for s in add if not s.get("description"))
    if missing:
        print(f"\n説明の無いものが {missing}件 あります。"
              f"\n  python3 tools/fetch_wikipedia_lists.py --extracts"
              f"\n  を走らせてから、もう一度ここへ戻ってきてください。")

    if not write:
        print("\n--write を付けると書き戻します。")
        return

    # 前回入れたぶんを、**収録ぜんぶから**取り除いてから書きます。
    #
    # はじめは spots-wp*.json を消すだけにしていました。それで足りると
    # 思っていましたが、**tools/reshard_kb.py が県ごとに並べ直すと、
    # 入れたものは spots-jp01-hokkaido.json のような県のファイルへ移り
    # ます**。消すファイルには、もう入っていません。
    #
    # 気づいたのは2回目を走らせたあとです。収録が 36,253 → 42,641 に
    # なりました。6,547件が二重に入っています。名前も座標も同じものが
    # 2つ並ぶので、旅程は同じ場所へ2回行きます。
    #
    # ファイルの名前ではなく、**印（src）で消します**。どこへ移されて
    # いても効きます。
    removed = 0
    for path, doc in shards.items():
        keep = [x for x in doc["spots"] if x.get("src") != SRC]
        removed += len(doc["spots"]) - len(keep)
        if len(keep) != len(doc["spots"]):
            doc["spots"] = keep
            with open(path, "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    if removed:
        print(f"  前回のぶん {removed}件 を取り除きました")
    for path in glob.glob(os.path.join(WEB, "kb", "spots-wp*.json")):
        os.remove(path)
        shards.pop(path, None)

    per_file = 2500
    chunks = [add[i:i + per_file] for i in range(0, len(add), per_file)]
    for n, chunk in enumerate(chunks):
        path = os.path.join(WEB, "kb", f"spots-wp{n:02d}.json")
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
    print("このあと tools/reshard_kb.py を走らせて、県ごとに並べ直します。")


if __name__ == "__main__":
    main("--write" in sys.argv)
