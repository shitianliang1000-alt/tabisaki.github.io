# -*- coding: utf-8 -*-
"""日本語版ウィキペディアの「一覧」記事から、行き先の素データを落とす。

出力は data/wikipedia/wp-<一覧名>.json（一覧ごとに1ファイル）です。
取り込みは tools/import_wikipedia_lists.py がします。ここは取ってくる
だけです。

なぜ一覧記事なのか
------------------
収録はすでに Wikidata から3万件ほど入っています。ただし Wikidata は
**分類（P31）が付いているものしか引けません**。日本の場所には、分類が
付いていない・付いていても粗い記事が相当あります。

    古墳        Wikidata の分類が付いているのは一部だけ
    温泉地      「温泉」と「温泉街」と「温泉地」が混ざる
    峠・渓谷    分類そのものが無いことが多い

一方、日本語版ウィキペディアには**人が手で並べた一覧記事**があります。
「日本の温泉地一覧」「日本の古墳一覧」のような記事は、その分野に
詳しい人が「これは載せる」と判断した結果です。分類より粗いですが、
**判断が入っている**ぶん、旅程に出して困らないものが並びます。

やりかた
--------
  1. 一覧記事から、本文の中のリンク（名前空間0）をぜんぶ拾う
  2. そのリンク先を50件ずつまとめて、座標と冒頭2文を聞く
  3. 座標のあるものだけを残す（無いものは場所ではありません）

1と2はどちらも MediaWiki の API です。**本文を解析しません。**
表の書き方は記事ごとにばらばらで、解析すると記事が直されるたびに
壊れます。リンクと座標だけを見ていれば、書き方が変わっても動きます。

出典について
------------
ウィキペディアの文章は CC BY-SA です。収録に入れるのは

    ・記事の題（＝場所の名前）
    ・座標
    ・冒頭の2文（説明）

で、出典に「Wikipedia」と記事名を必ず持たせます（import 側）。

    python3 tools/fetch_wikipedia_lists.py            ぜんぶ
    python3 tools/fetch_wikipedia_lists.py 日本の山一覧  1つだけ
    python3 tools/fetch_wikipedia_lists.py --list      一覧の名前を出す
"""
import glob
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
OUT = os.path.join(WEB, "data", "wikipedia")

API = "https://ja.wikipedia.org/w/api.php"
# 一覧記事の中身は、こちらからもらいます（理由は links_of に書きました）。
REST = "https://api.wikimedia.org/core/v1/wikipedia/ja"
# 名前空間の頭。日本語版は英語の頭も通るので、両方並べます。
NAMESPACES = {
    "Category", "カテゴリ", "File", "ファイル", "Template", "Template talk",
    "Help", "Portal", "Wikipedia", "WP", "Special", "特別", "Talk", "ノート",
    "利用者", "User", "プロジェクト", "Module", "モジュール", "Image",
}
UA = ("tabisaki-kb/1.0 (https://github.com/shitianliang1000-alt/"
      "tabisaki.github.io; kb build)")

# 取ってくる一覧と、収録の分類。
#
# 分類は**収録側にすでにある名前**に寄せます。新しい名前を作ると、
# 滞在時間もジャンルも既定値になり、どれも同じ扱いになります
# （js/access.js・js/replan.js・js/arrive.js はどれも分類で動きます）。
LISTS = {
    "日本の温泉地一覧": "温泉",
    "日本の古墳一覧": "史跡",
    "日本の湖沼一覧": "湖",
    "日本の山一覧": "山",
    "日本の川一覧": "川",
    "日本の寺院一覧": "寺院",
    "日本の島の一覧": "島",
    "日本の史跡一覧": "史跡",
    "日本の国宝一覧": "建築",
    "日本の人造湖一覧": "湖",
    "日本の観光地一覧": "観光名所",
    "日本の特別史跡一覧": "史跡",
    "日本の特別名勝一覧": "庭園",
    "日本の用水路一覧": "川",
    "神社一覧": "神社",
    "日本のスキー場一覧": "スキー場",
    "日本の橋一覧": "建築",
    "重要文化財一覧": "建築",
    "日本の植物園一覧": "公園",
    "日本の峡谷・渓谷一覧": "渓谷",
    "日本国指定名勝の一覧": "庭園",
    "日本の峠一覧": "峠",
    "日本の鉱山の一覧": "史跡",
    "日本の海水浴場一覧": "海水浴場",
}

# 都道府県ごとの「〇〇の観光地」。
#
# 全国の一覧は、載る基準が厳しくなりがちです（全国区の場所しか
# 載りません）。県ごとの記事のほうが、その土地の人が行く場所まで
# 拾えます。旅程に欲しいのは、まさにそちらです。
PREFECTURES = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
    "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
    "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
    "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
]
for _p in PREFECTURES:
    LISTS[f"{_p}の観光地"] = "観光名所"

# 相手は寄付で動いている公共の百科事典です。急ぎません。
#
# 1.2秒で回したら 429（多すぎ）が続けて返り、3秒でもまだ返りました。
# 共用の回線から名乗らずに叩いているので、こちらが遠慮する側です。
# 8秒まで落とすと通ります。全部で1時間ほどかかりますが、相手に
# 迷惑をかけてまで速く終わらせる理由はありません。
PAUSE_SEC = 8.0
BATCH = 50          # 座標を聞くときの、1回あたりの件数（APIの上限）
RETRIES = [15, 45, 120, 300, 600]


def call(params):
    """API を1回叩きます。429（多すぎ）は待ってやり直します。"""
    url = API + "?" + urllib.parse.urlencode(params)
    for wait in RETRIES + [None]:
        r = subprocess.run(
            ["curl", "-s", "-m", "60", "-A", UA, "-w", "\n%{http_code}", url],
            capture_output=True, text=True)
        body, _, code = r.stdout.rpartition("\n")
        if code.strip() == "200":
            try:
                return json.loads(body)
            except json.JSONDecodeError:
                pass
        if wait is None:
            break
        sys.stderr.write(f"    {code.strip()} … {wait}秒待ちます\n")
        time.sleep(wait)
    # 429（多すぎ）が続くときは、**こちらの速さの問題とは限りません**。
    # 共用の回線から叩いていると、同じ出口を使うほかの人のぶんも合わせて
    # 数えられ、1秒に1回でも断られることがあります。待っても通らない
    # ときは、そう言って止めます（叩き続けても迷惑なだけです）。
    raise SystemExit(
        f"ウィキペディアの API に届きませんでした（{code.strip()}）。\n"
        "  429 が続くときは、この回線からの問い合わせが多すぎます。\n"
        "  時間をおいてもう一度走らせてください。\n"
        "  **聞いたぶんは data/wikipedia/ に残っているので、続きから進みます。**")


def get(url):
    """URL を1本取って、中身をそのまま返します。429 は待ってやり直します。

    call() は JSON を返す API 用です。こちらは REST から HTML を
    もらうので、別にしています。取れなければ None を返します——
    **空文字を返すと「リンクが1件も無い一覧」と見分けが付きません。**
    """
    for wait in RETRIES + [None]:
        r = subprocess.run(
            ["curl", "-s", "-m", "120", "-A", UA, "-w", "\n%{http_code}", url],
            capture_output=True, text=True)
        body, _, code = r.stdout.rpartition("\n")
        if code.strip() == "200":
            return body
        if wait is None:
            break
        sys.stderr.write(f"    {code.strip()} … {wait}秒待ちます\n")
        time.sleep(wait)
    return None


def links_of(title):
    """その一覧記事が、本文から張っているリンク（名前空間0）。

    **action API の prop=links は使えません。** 一覧記事のリンクは1本で
    1800件を超えることがあり、ウィキメディアはこの「高い」問い合わせに
    厳しい上限をかけています。共用の回線から叩くと、1回目から 429 が
    返り、待っても通りません（8秒あけても、15秒あけても同じでした）。

    代わりに REST（api.wikimedia.org）から**組み上がった HTML** を
    もらいます。こちらは記事1本ぶんが1回で返り、通ります。

    HTML からは <a rel="mw:WikiLink"> の href だけを拾います。
    **表は読みません。** 一覧記事の表の書き方は記事ごとにばらばらで、
    列の意味を読もうとすると、記事が直されるたびに壊れます。リンクなら
    書き方が変わっても、指している先は変わりません。
    """
    url = (REST + "/page/" + urllib.parse.quote(title, safe="") + "/html")
    html = get(url)
    if html is None:
        sys.stderr.write(f"  （{title} は取れませんでした）\n")
        return []
    out, seen = [], set()
    for href in re.findall(r'rel="mw:WikiLink"[^>]*href="\./([^"#]+)"', html):
        name = urllib.parse.unquote(href).replace("_", " ")
        # 名前空間つき（Category: や ファイル: など）は場所ではありません。
        if ":" in name and name.split(":", 1)[0] in NAMESPACES:
            continue
        if name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def load_cache():
    """題 → 座標の控え。一覧どうしで同じ記事が何度も出てきます。"""
    path = os.path.join(OUT, "places.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_cache(cache):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "places.json"), "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)


def places_of(titles, cache):
    """題から、座標と冒頭2文を引きます。

    **一度聞いた題は、二度聞きません。** 一覧は互いに重なります
    （「京都府の観光地」と「日本の観光地一覧」に同じ寺が出ます）。
    控えを1つ持って、全部の一覧で使い回します。座標の無いものも
    「無い」と覚えます（覚えないと、毎回聞き直すことになります）。
    """
    todo = [t for t in titles if t not in cache]
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        doc = call({
            "action": "query", "format": "json",
            "titles": "|".join(chunk),
            "prop": "coordinates|extracts",
            "coprop": "type|name", "coprimary": "primary",
            "exintro": "1", "explaintext": "1", "exsentences": "2",
            "redirects": "1",
        })
        # 転送（リダイレクト）は、元の題でも引けるようにしておきます。
        alias = {r["from"]: r["to"]
                 for r in doc.get("query", {}).get("redirects", [])}
        seen = set()
        for page in doc.get("query", {}).get("pages", {}).values():
            title = page.get("title", "")
            seen.add(title)
            coords = page.get("coordinates") or []
            c = coords[0] if coords else None
            if not c or c.get("globe", "earth") != "earth":
                cache[title] = None
                continue
            cache[title] = {
                "title": title, "lat": c["lat"], "lng": c["lon"],
                "extract": (page.get("extract") or "").strip(),
            }
        for src, dst in alias.items():
            cache[src] = cache.get(dst)
        # 返ってこなかった題も「無い」として覚えます。
        for t in chunk:
            if t not in cache:
                cache[t] = None
        save_cache(cache)
        got = sum(1 for t in titles if cache.get(t))
        sys.stderr.write(f"    {min(i + BATCH, len(todo))}/{len(todo)}"
                         f"  座標あり {got}件\n")
        time.sleep(PAUSE_SEC)
    return [cache[t] for t in titles if cache.get(t)]


def slug(title):
    """ファイル名。題をそのまま使うと、記号で困ることがあります。"""
    return title.replace("/", "_").replace("・", "_")


def links_path(title):
    return os.path.join(OUT, f"links-{slug(title)}.json")


def fetch_links(title, category):
    """その一覧の**リンクだけ**を取って、すぐ保存します。

    座標を引くのは、そのあとでまとめてやります。リンクを数えるのは
    1〜2回の問い合わせで済むので、**先に全部の一覧ぶんを押さえて**
    おけば、途中で断られても「どの一覧に何が載っているか」は残ります。
    """
    path = links_path(title)
    if os.path.exists(path):
        return
    sys.stderr.write(f"  {title}: リンクを数えています…\n")
    titles = links_of(title)
    if not titles:
        return
    os.makedirs(OUT, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"list": title, "category": category, "titles": titles},
                  f, ensure_ascii=False)
    sys.stderr.write(f"    リンク {len(titles)}件\n")
    time.sleep(PAUSE_SEC)


def all_titles():
    """保存した一覧ぜんぶの、題の union。重なりは1つに数えます。"""
    seen = {}
    for path in sorted(glob.glob(os.path.join(OUT, "links-*.json"))):
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        for t in doc.get("titles", []):
            seen[t] = True
    return list(seen)


def main(argv):
    if "--list" in argv:
        for t, c in LISTS.items():
            print(f"{t}\t{c}")
        return
    want = [a for a in argv if not a.startswith("--")]
    todo = {t: c for t, c in LISTS.items() if not want or t in want}
    if want and not todo:
        raise SystemExit(f"知らない一覧です: {' '.join(want)}")

    # 1. まず、どの一覧に何が載っているかを押さえます（安い）。
    sys.stderr.write(f"{len(todo)}件の一覧の、リンクを集めます\n")
    for title, category in todo.items():
        fetch_links(title, category)

    # 2. そのあと、題をまとめて座標に直します（高い）。
    cache = load_cache()
    titles = all_titles()
    todo_n = sum(1 for t in titles if t not in cache)
    sys.stderr.write(f"題 {len(titles)}件（控えに {len(cache)}件 /"
                     f" これから {todo_n}件）\n")
    places_of(titles, cache)
    have = sum(1 for t in titles if cache.get(t))
    sys.stderr.write(f"座標のあるもの {have}件\n")


if __name__ == "__main__":
    main(sys.argv[1:])
