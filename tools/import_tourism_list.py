# -*- coding: utf-8 -*-
"""県ごとの「観光地の名前の一覧」（xlsx）から、収録に足せるものだけを足す。

    python3 tools/import_tourism_list.py 一覧.xlsx --check   確認するだけ
    python3 tools/import_tourism_list.py 一覧.xlsx --write   足して書き戻す

何が入っているファイルか
------------------------
2列だけです。

    都道府県 | 観光地名

**座標も、分類も、説明も、出典の名前もありません。** 収録の1件には
座標が要ります（地図にも移動時間にも使います）。名前だけでは置けません。

だから、この道具は**置けるものだけを足します**。座標は作りません。

    1. 名前と県が、すでに収録にある      → 足さない（二重になる）
    2. 名前が、ウィキペディアの記事と一致し、
       その記事の座標が、一覧の県に入っている → 足す（座標は記事のもの）
    3. それ以外                            → 足さない（置けないので）

3つ目が大半です（5万件のうち、置けるのは2割ほど）。落とした名前は
data/wikipedia/tourlist-unplaced.json に残します。あとで座標を付ける
手段（国土地理院の住所検索など）ができたときの材料です。

県が合っているか、を必ず見ます
------------------------------
「氷川神社」「八幡宮」「大師堂」のような名前は、どの県にもあります。
名前が同じ記事があっても、**それが別の県の記事なら別の場所です。**
座標が一覧の県の中に入っているものだけを採ります。同じ名前の記事が
その県に2つ以上あるときは、どちらか決められないので足しません。

外すもの
--------
  ・【閉店】【閉館】【休業】【廃止】…と付いているもの
    **閉まっている所へ案内しないためです。** 実際に混ざっていました
    （「【閉店】Orii gallery…」「【閉館】亀谷温泉 白樺の湯」）。
  ・店・会社・体験・催し（日付を持っていないので旅程に入れられません）
  ・ウィキペディアの一覧を取り込んだときと同じ「行き先にならないもの」

出典
----
座標と説明は**ウィキペディアの記事**のものです。収録には
Wikipedia とだけ書きます。この一覧そのものは、名前が「観光地として
挙がっている」ことの確認に使うだけで、名前・座標・説明のどれも
ここから写していません。
"""
import collections
import glob
import hashlib
import json
import os
import re
import sys
import unicodedata
import zipfile
from xml.etree import ElementTree as ET

from dedupe_spots import same_place
from import_wikipedia_lists import (
    AN_EVENT, MAX_REGION_KM, NOT_A_DESTINATION, SOURCE_LINKS,
    describe, km, load_shards, looks_unusable, register,
)

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
RAW = os.path.join(WEB, "data", "wikipedia")

# 前回このファイルが入れたぶんを取り除くための印。
# ウィキペディアの一覧の取り込み（src="wikipedia"）とは別にしてあります。
# 同じ印にすると、あちらを走らせたときにこちらのぶんが消えます。
SRC = "wikipedia-tourlist"

# 出典に足す名前。**画面の下の「データ: …」にそのまま出ます。**
#
# 名前・座標・説明はウィキペディアの記事のものですが、「観光地として
# 挙がっている」ことの確認に、各都道府県の公式観光サイトの一覧を使って
# います。その旨を、利用する側にも見えるようにします（ご指示があり
# ました）。個々のサイトの URL は、ファイルに書かれていないので空です。
EXTRA_SOURCES = [{"name": "各都道府県の公式観光サイト", "url": ""}]

# 閉まっている、という札。【閉店】【閉館】【休業】【営業終了】【廃止】…
CLOSED = re.compile(r"[【\[（(][^】\]）)]*(閉店|閉館|閉園|閉鎖|休業|休館|休止|廃止|廃業|終了|移転|解体)[^】\]）)]*[】\]）)]")
CLOSED_WORD = re.compile(r"^(閉店|閉館|閉園|閉鎖|休業|廃止)")

# 店・会社・体験。行き先ではなく、事業者や催しです。
#
# 「本店」「支店」で終わるものも、店です（牛銀本店・平治煎餅本店）。
# 飲食の語（レストラン・カフェ）は外しません。「ラーメン滑走路」のように
# 店の名前に見えて、公園や施設の名前であることがあります。**名前だけで
# 決められないものは、決めずに残します。**
BUSINESS = re.compile(r"(株式会社|有限会社|合資会社|合名会社|合同会社|協同組合"
                      r"|本店$|支店$|営業所$|販売所$|直売所$)")
EXPERIENCE = re.compile(r"(体験|教室|ツアー|クルーズ)$")

# 泊まる所。行き先ではありません。
#
# 旅程の宿は別に持っています（js/lodging.js・js/stays.js）。立ち寄りに
# 山小屋やホテルが並ぶと、「白馬山荘 45分」と出ます。寝る場所に着いても、
# 見て回るものがありません。
#
#   白馬山荘 / 種池山荘 / 大沢小屋     … 北アルプスの山小屋です
#   ○○ホテル / ○○旅館 / ○○民宿      … 泊まる所です
#
# 名前の形で見分けられるものだけです。「ヒルトン福岡シーホーク」のように
# 宿泊の語を含まないホテルは、名前からは分かりません。
LODGING = re.compile(r"(ホテル|旅館|民宿|ロッジ|コテージ|ゲストハウス|"
                     r"ヒュッテ|山荘|山小屋|ペンション|リゾートイン)")

# 名前の終わりから決められる分類。**言い切れるものだけ**です。
# 決められないものは「観光名所」にします（決めずに置く、という意味です）。
#
#   「〇〇寺」は寺院ですが、「〇〇寺跡」は史跡です。終わりだけで見ます。
#   「池」は庭の池のことも大きな池のこともあるので入れません。
SUFFIX_CATEGORY = (
    ("海水浴場", "海水浴場"), ("スキー場", "スキー場"), ("温泉", "温泉"),
    ("美術館", "美術館"), ("博物館", "博物館"), ("水族館", "水族館"),
    ("動物園", "動物園"), ("植物園", "公園"), ("庭園", "庭園"),
    ("古墳", "史跡"), ("城跡", "史跡"), ("遺跡", "史跡"), ("貝塚", "史跡"),
    ("神社", "神社"), ("大社", "神社"), ("神宮", "神社"), ("八幡宮", "神社"),
    ("寺", "寺院"), ("院", "寺院"),
    ("城", "城"), ("公園", "公園"), ("滝", "滝"), ("峡", "渓谷"),
    ("渓谷", "渓谷"), ("湖", "湖"), ("岬", "岬"), ("峠", "峠"),
    ("島", "島"), ("山", "山"), ("ダム", "ダム"), ("灯台", "灯台"),
    ("橋", "建築"), ("道の駅", "道の駅"), ("商店街", "商店街"),
    ("酒造", "酒蔵"), ("酒蔵", "酒蔵"), ("銘醸", "酒蔵"),
)


def n(text):
    """比べるための形。全角半角・空白・中黒を畳みます。"""
    return re.sub(r"[\s　・]", "", unicodedata.normalize("NFKC", text))


def read_xlsx(path):
    """xlsx の1枚目を [(県, 名前)] に。**標準ライブラリだけで読みます。**

    openpyxl を使えば楽ですが、ほかの道具（tools/*.py）は標準ライブラリ
    だけで動きます。ここだけ何かを入れてもらうと、走らせる前に躓きます。
    2列だけの表なので、zip の中の XML を直接読めば足ります。
    """
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", ns):
                shared.append("".join(t.text or "" for t in si.iter(
                    "{%s}t" % ns["m"])))
        book = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        rid2target = {r.get("Id"): r.get("Target") for r in rels}
        sheets = {}
        for s in book.find("m:sheets", ns):
            rid = s.get("{http://schemas.openxmlformats.org/officeDocument/"
                        "2006/relationships}id")
            target = rid2target[rid].lstrip("/")
            if not target.startswith("xl/"):
                target = "xl/" + target
            sheets[s.get("name")] = target

        def rows_of(target):
            root = ET.fromstring(z.read(target))
            for row in root.iter("{%s}row" % ns["m"]):
                cells = {}
                for c in row.findall("m:c", ns):
                    col = re.match(r"[A-Z]+", c.get("r")).group(0)
                    v = c.find("m:v", ns)
                    if v is None:
                        is_ = c.find("m:is", ns)
                        cells[col] = "".join(
                            t.text or "" for t in is_.iter(
                                "{%s}t" % ns["m"])) if is_ is not None else ""
                    elif c.get("t") == "s":
                        cells[col] = shared[int(v.text)]
                    else:
                        cells[col] = v.text or ""
                yield cells

        main = sheets.get("観光地一覧") or next(iter(sheets.values()))
        out = [(r.get("A", "").strip(), r.get("B", "").strip())
               for r in rows_of(main)]
        out = [x for x in out[1:] if x[0] and x[1]]   # 見出し行を除く
        status = []
        if "取得状況" in sheets:
            status = [r for r in rows_of(sheets["取得状況"])][1:]
    return out, status


def clean_name(raw):
    """名前の飾りを外します。外せないほどの飾りなら None。"""
    name = unicodedata.normalize("NFKC", raw).strip()
    # 閉まっている、という札。**入れると閉まっている所へ案内します。**
    if CLOSED.search(name) or CLOSED_WORD.match(name):
        return None
    # 先頭の【エリア名】は札です（【藤沢市】片瀬東浜海水浴場）。
    name = re.sub(r"^【[^】]*】\s*", "", name)
    name = name.strip()
    if BUSINESS.search(name) or EXPERIENCE.search(name) or LODGING.search(name):
        return None
    if name.endswith(AN_EVENT):
        return None
    return name or None


def variants(name):
    """突き合わせる名前の候補。長い（元のまま）ほうを先に。"""
    out = [name]
    bare = re.sub(r"[（(][^）)]*[）)]", "", name).strip()
    if bare and bare != name:
        out.append(bare)
    # 「羊蹄山（蝦夷富士）」→「羊蹄山」は上で足ります。
    # 「〜・〜」で2つの名前が並んでいるときは、先頭を試します。
    head = re.split(r"[・／/]", bare or name)[0].strip()
    if head and head not in out and len(head) >= 3:
        out.append(head)
    return out


def category_of(name):
    for suffix, cat in SUFFIX_CATEGORY:
        if name.endswith(suffix):
            return cat
    return "観光名所"


def spot_id(pref, name):
    h = hashlib.sha1(f"{pref}/{name}".encode("utf-8")).hexdigest()[:10]
    return f"tl-{h}"


def main(path, write):
    rows, status = read_xlsx(path)
    print(f"一覧 {len(rows)}件")

    with open(os.path.join(RAW, "coords.json"), encoding="utf-8") as f:
        coords = json.load(f)
    places = {}
    ppath = os.path.join(RAW, "places.json")
    if os.path.exists(ppath):
        with open(ppath, encoding="utf-8") as f:
            places = json.load(f)

    with open(os.path.join(WEB, "kb", "regions.json"), encoding="utf-8") as f:
        regions_doc = json.load(f)
    regions = regions_doc["regions"]
    region_pref = {r["id"]: r["prefecture"] for r in regions}

    # 記事名（括弧の注を外した形）→ 記事名の並び。
    by_bare = collections.defaultdict(list)
    for title in coords:
        by_bare[n(re.sub(r"\s*[（(][^）)]*[）)]\s*$", "", title))].append(title)

    def region_near(lat, lng):
        best, best_d = None, None
        for r in regions:
            d = (r["lat"] - lat) ** 2 + (r["lng"] - lng) ** 2
            if best_d is None or d < best_d:
                best, best_d = r, d
        return best

    def in_prefecture(lat, lng, pref):
        """座標が、その県のエリアの近くにあるか。"""
        r = region_near(lat, lng)
        return (r is not None and r["prefecture"] == pref
                and km(lat, lng, r["lat"], r["lng"]) <= MAX_REGION_KM), r

    shards = load_shards()
    # 前回ここが入れたぶんは、数え直します（2回走らせても二重にならない）。
    existing = [s for doc in shards.values() for s in doc["spots"]
                if s.get("src") != SRC]
    named = collections.defaultdict(list)
    for s in existing:
        named[n(s["name"])].append(s)
    grid = collections.defaultdict(list)
    for s in existing:
        grid[(round(s["lat"] / 0.05), round(s["lng"] / 0.05))].append(s)

    add, unplaced = [], []
    why = collections.Counter()
    seen_pref = collections.Counter()
    for pref, raw in rows:
        seen_pref[pref] += 1
        name = clean_name(raw)
        if not name:
            why["閉店・店・宿・体験・催し"] += 1
            continue
        if looks_unusable(name, 35.0, 135.0) or name.endswith(NOT_A_DESTINATION):
            why["行き先にならない名前"] += 1
            continue
        # 1. すでに収録にある（同じ県の同じ名前）。
        vs = variants(name)
        if any(pref == region_pref.get(s["regionId"])
               for v in vs for s in named.get(n(v), [])):
            why["すでに収録にある"] += 1
            continue
        # 2. ウィキペディアの記事と一致し、座標が一覧の県に入っている。
        found = []
        for v in vs:
            for title in by_bare.get(n(v), []):
                lat, lng = coords[title]
                ok, region = in_prefecture(lat, lng, pref)
                if ok:
                    found.append((title, lat, lng, region))
            if found:
                break
        if not found:
            unplaced.append([pref, raw])
            why["座標が引けない"] += 1
            continue
        if len({f[0] for f in found}) > 1:
            # 同じ名前の記事が、その県に2つ以上ある。**どちらか決めません。**
            unplaced.append([pref, raw])
            why["同じ県に同名の記事が複数（決められない）"] += 1
            continue
        title, lat, lng, region = found[0]
        # 表示する名前（括弧の注を外した形）。**これでも重複を見ます。**
        shown = re.sub(r"\s*[（(][^）)]*[）)]\s*$", "", title).strip() or title
        # 記事名（括弧つき）だけで比べていたら、実際に取りこぼしました。
        #
        #   本興寺 (蒲郡市)  ／ 花見(本興寺)      … 括弧どうしは比べない
        #   夫婦岩 (伊勢市)  ／ 二見興玉神社（夫婦岩）
        #   中山神社 (下松市) ／ 中山神社(初詣)
        #
        # 収録側の括弧は「別名」や「催しの名前」です。括弧を外した名前と
        # 比べないと、同じ場所が二重に入ります。
        probes = [{"name": title, "lat": lat, "lng": lng},
                  {"name": shown, "lat": lat, "lng": lng}]
        gx, gy = round(lat / 0.05), round(lng / 0.05)
        near = [x for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                for x in grid[(gx + dx, gy + dy)]]
        if any(same_place(pr, s, km(lat, lng, s["lat"], s["lng"]))
               for pr in probes for s in near):
            why["すでに収録にある（座標つきで一致）"] += 1
            continue
        # 表示する名前は、記事名から**括弧の注を外した形**です。
        #
        #   一宮神社 (北九州市)  →  一宮神社
        #
        # 括弧は同じ名前の記事を区別するための、ウィキペディア側の書き方
        # です。そのまま出すと「一宮神社 (北九州市)」と画面に並びます。
        # リンク先の記事名は wikipedia 欄に残すので、たどれます。
        # **表示する名前でも、行き先かどうかを確かめます。**
        #
        # 一覧の名前は「沢入駅（アジサイ）」のように括弧が付いていて、
        # 最初の確かめ（上の looks_unusable）は駅と気づきませんでした。
        # 括弧を外した名前で見直すと、駅が5件漏れていました。
        if (looks_unusable(shown, lat, lng)
                or shown.endswith(NOT_A_DESTINATION)
                or LODGING.search(shown) or BUSINESS.search(shown)):
            why["行き先にならない名前"] += 1
            continue
        spot = {
            "id": spot_id(pref, name),
            "regionId": region["id"],
            "name": shown,
            "category": category_of(shown),
            "lat": round(lat, 5),
            "lng": round(lng, 5),
            # 一覧は1つだけです。**定番かどうかを決める材料がありません。**
            # ウィキペディアの一覧の取り込みと同じ扱い（1つなら hidden）にします。
            "fame_tier": "hidden",
            "wikipedia": title,
            "src": SRC,
            "_raw": raw,
        }
        cached = (places.get(title) or {}).get("extract", "")
        desc = describe(cached)
        if desc:
            spot["description"] = desc
        add.append(spot)
        grid[(gx, gy)].append(spot)
        named[n(title)].append(spot)
        why["足す"] += 1

    print("\n内訳:")
    for k, v in why.most_common():
        print(f"  {k}: {v}件")
    by_cat = collections.Counter(s["category"] for s in add)
    print(f"\n足す {len(add)}件（説明つき {sum(1 for s in add if s.get('description'))}件）")
    for cat, c in by_cat.most_common():
        print(f"  {cat} {c}件")

    if status:
        print("\n一覧が**そろっていない県**（この道具では補えません）:")
        for r in status:
            state = r.get("D", "")
            if state and "全ページ取得済み" not in state:
                print(f"  {r.get('A')}: {r.get('B')}件 — {state}")

    if "--show" in sys.argv:
        import random
        random.seed(11)
        print("\n無作為に30件（一覧の名前 → 記事名 / 県 / 分類）:")
        for s in random.sample(add, min(30, len(add))):
            r = region_pref.get(s["regionId"])
            same = "" if s["_raw"] == s["name"] else f"  ←「{s['_raw']}」"
            print(f"  {r} {s['name']} [{s['category']}]{same}")

    for s in add:
        s.pop("_raw", None)

    if not write:
        print("\n--write を付けると書き戻します。")
        return

    os.makedirs(RAW, exist_ok=True)
    with open(os.path.join(RAW, "tourlist-unplaced.json"), "w",
              encoding="utf-8") as f:
        json.dump(unplaced, f, ensure_ascii=False)

    # 前回のぶんを、収録ぜんぶから印（src）で取り除きます。
    # ファイルの名前では消しません（reshard_kb.py が県ごとに並べ直すと、
    # 入れたものは県のファイルへ移ります）。
    removed = 0
    for p, doc in shards.items():
        keep = [x for x in doc["spots"] if x.get("src") != SRC]
        removed += len(doc["spots"]) - len(keep)
        if len(keep) != len(doc["spots"]):
            doc["spots"] = keep
            with open(p, "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    for p in glob.glob(os.path.join(WEB, "kb", "spots-tl*.json")):
        os.remove(p)
        shards.pop(p, None)
    if removed:
        print(f"  前回のぶん {removed}件 を取り除きました")

    per_file = 2500
    for i in range(0, len(add), per_file):
        chunk = add[i:i + per_file]
        p = os.path.join(WEB, "kb", f"spots-tl{i // per_file:02d}.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"spots": chunk}, f, ensure_ascii=False,
                      separators=(",", ":"))
        shards[p] = {"spots": chunk}
    # **索引に登録します。** reshard_kb.py は index.json の段の一覧から
    # 読むので、登録しないと並べ直しが読まずに消します（書いた2,020件が
    # 1件も残りませんでした）。
    total = register(shards, regions_doc, EXTRA_SOURCES)
    print(f"\n収録 {total}件になりました。")
    print("このあと tools/reshard_kb.py を走らせて、県ごとに並べ直します。")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        raise SystemExit("xlsx のパスを渡してください。")
    main(args[0], "--write" in sys.argv)
