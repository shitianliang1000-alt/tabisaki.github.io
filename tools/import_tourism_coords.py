# -*- coding: utf-8 -*-
"""座標つきの観光地一覧（xlsx）から、重複を確かめながら収録に足す。

    python3 tools/import_tourism_coords.py 一覧.xlsx --check   確認するだけ
    python3 tools/import_tourism_coords.py 一覧.xlsx --write   足して書き戻す
    python3 tools/import_tourism_coords.py 一覧.xlsx --check --show   見本も出す

何が入っているファイルか
------------------------
tools/import_tourism_list.py で読んだ「各都道府県の公式観光サイトの名前の
一覧」に、**いただいた側で座標を付けたもの**です。シートは6枚あります。

    観光地一覧          座標つき（Yahoo!ローカルサーチ・コンテンツジオコーダ、
                        国土地理院、Photon、Nominatim、Wikipedia ほか）
    代表名まとめ        「なべくら高原・森の家 新緑祭」のような行を、
                        代表名（なべくら高原）にまとめたもの
    Web調査結果         手で調べたもの（確度 高・中・低）
    見つからず          座標が無い
    要確認              5件以上で同じ座標を共有している（取り違えの疑い）
    観光地以外（除外）  祭り・体験・乗り物など

**入れるのは「観光地一覧」と、「Web調査結果」の確度が高・中のものだけ**です。
「要確認」は、いただいた側が疑わしいと印を付けたものなので入れません。
確度「低」も入れません（「緯度が小数点以下3桁のみ」など）。

祭りなどの追加表記は、外して入れます（ご指示です）
------------------------------------------------------
観光地の一覧には、場所の名前に催しが付いた行が並んでいます。

    なべくら高原・森の家 春の森を歩こう 新緑祭   → なべくら高原
    高橋まゆみ人形館・秋のテーマ展 冬の日の足跡  → 高橋まゆみ人形館
    信州大芝高原の桜                             → 信州大芝高原

1行ずつ simplify() で催しの部分を外します。外したあとは、同じ場所が何度も
出てくるので、**1つにまとめてから**収録と突き合わせます。いただいた一覧の
「まとめ名（代表名）」の列は使いません（理由は collect() に書きました）。

重複の確かめ方
--------------
  1. 一覧の中で：県と名前（外したあと）が同じなら1つ
  2. 収録と：近くて名前が同じ・似ている（dedupe_spots.same_place）なら足さない
  3. 収録と：同じエリアに同じ名前があれば足さない（旅程に2回出るため）
  4. 同じ座標を、名前の違う3件以上が分け合っていたら足さない
     （住所の代表点に落ちた疑い。「要確認」に入らなかったぶん）

**収録のほうが間違っていたら、直します。** 以前の取り込み
（tools/import_osm_tourlist.py など）は、名前が全国で1つなら県が食い違っても
採りました（listedIn に一覧の県が残っています）。この一覧は県ごとに調べた
座標なので、同じ名前が一覧の県の中にあれば、**県の食い違ったほうを外して、
こちらを入れます。**

入れないもの
------------
  ・飲食店・カフェ・売店・宿・レンタカーなど（js/meals.js の原則：閉店を
    見分けられない店へ案内しない。宿は行き先ではない）
  ・催しだけの名前（外したら何も残らないもの）
  ・駅・役所・学校など、行き先でないもの

出典
----
座標の取得元は1件ずつ geo に残します。画面の下の出典には、取得元のうち
収録に入ったものを足します（Yahoo! の API はクレジット表示が要ります）。
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
from import_tourism_list import (
    BUSINESS, CLOSED, CLOSED_WORD, LODGING, PrefectureLocator, SUFFIX_CATEGORY,
    is_ropeway, n,
)
from import_wikipedia_lists import (
    AN_EVENT, NOT_A_DESTINATION, WIDE_BY_SUFFIX, km, load_shards,
    looks_unusable, register,
)

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)

# 前回このファイルが入れたぶんを取り除くための印。
SRC = "tourlist-geocoded"

MAX_PLACE_KM = 100.0

PREF_SOURCE = {"name": "各都道府県の公式観光サイト", "url": ""}

# 取得元 → 画面の下に出す出典。
#
# Yahoo! JAPAN の Web API は「Web Services by Yahoo! JAPAN」の表示が
# 求められています。Photon と Nominatim は OpenStreetMap のデータです
# （ODbL。出典はすでに入っています）。
GEO_SOURCES = {
    "Yahooローカルサーチ": {"name": "Web Services by Yahoo! JAPAN",
                            "url": "https://developer.yahoo.co.jp/sitemap/"},
    "Yahooコンテンツジオコーダ": {"name": "Web Services by Yahoo! JAPAN",
                                  "url": "https://developer.yahoo.co.jp/sitemap/"},
    "国土地理院": {"name": "国土地理院", "url": "https://www.gsi.go.jp/"},
    "Photon": {"name": "© OpenStreetMap contributors (ODbL)",
               "url": "https://www.openstreetmap.org/copyright"},
    "Nominatim": {"name": "© OpenStreetMap contributors (ODbL)",
                  "url": "https://www.openstreetmap.org/copyright"},
    "Overpass(OSM)": {"name": "© OpenStreetMap contributors (ODbL)",
                      "url": "https://www.openstreetmap.org/copyright"},
    "Wikipedia": {"name": "Wikipedia", "url": "https://ja.wikipedia.org/"},
    "Wikidata": {"name": "Wikidata（CC0）", "url": "https://www.wikidata.org/"},
}

# 店・宿・レンタカー。**名前に出ているものだけ**で見分けます。
#
# Yahoo! のローカルサーチは店の検索なので、一覧の名前で引くと店の座標が
# 返ります。一覧には「ティールーム 清平」「福岡醤油店」「二戸シティホテル」
# 「トヨタレンタリース栃木 小山駅西口店」が入っていました。
#
# 店は閉店を見分けられません（js/meals.js の原則：閉店した店の前に立たせる
# のが、いちばん悪い結果です）。宿は行き先ではありません。
SHOP = re.compile(
    r"(懐石|割烹|料亭|料理|三交イン|ドーミーイン|スーパーホテル|食事処|お食事|(とうふ|豆腐|甘味|お休み|茶|うなぎ|鰻|寿司|めし)処|レストラン|ダイニング|カフェ|喫茶|珈琲|コーヒー|ティールーム|"
    r"食堂|そば処|蕎麦処|手打ち?そば|うどん|ラーメン|らーめん|寿司|鮨|すし処|"
    r"焼肉|焼き肉|居酒屋|酒場|バル$|ビストロ|トラットリア|ピッツェリア|"
    r"ベーカリー|パン工房|洋菓子|和菓子|菓子店|菓子舗|スイーツ|ジェラート|"
    r"ショップ|商店|酒店|醤油店|鮮魚店|精肉店|青果|専門店|"
    r"[^本支]店$|店[ 　]|本舗|"
    r"レンタカー|レンタリース|レンタサイクル|タクシー|バス営業|"
    r"カプセル|ホステル|イン$|旅籠|宿坊|ビジネス|"
    r"美容|理容|クリニック|医院|薬局|"
    r"不動産|建設|工務店|製作所|"
    r"グリル|GRILL|CAFE|Cafe|cafe|LOUNGE|菓工房|カステラ|ロッヂ|の宿|宿 |"
    r"ステイ|イン[ 　]|東横|ルートイン|アパホテル|リブマックス|やど|"
    r"グランピング|glamp|Glamp|"
    r"(?<![別山])荘$|^JA|農協|協会$|組合$|"
    r"^(?!旧).*[^小茶問]屋$)")

# 運動施設。行き先ではなく、使いに行く所です（Overture の取り込みと同じ）。
SPORTS = re.compile(
    r"(テニス|武道館|グラウンド|グランド|野球場|球場|運動場|競技場|陸上|"
    r"プール|ゲートボール|多目的広場|練習場|弓道場|サッカー場|競輪場|"
    r"競艇場|ボートレース|オートレース|体育館|総合運動|スポーツセンター|"
    r"保健福祉センター|公民館|コミュニティセンター)")

# 場所ではないもの（歩き方・芸能・コースの名前）。
NOT_PLACE = re.compile(r"(コース$|歩き$|めぐり$|巡り$|芸能$|ルート$|モデル)")

# 名前の前に付いた指定の札（重要文化財 熊谷家住宅 → 熊谷家住宅）。
DESIGNATION = re.compile(
    r"^(((国|県|府|都|道|市|町|村)指定)?(国宝|重要文化財|登録有形文化財|"
    r"有形文化財|史跡|名勝|天然記念物|特別史跡|特別名勝)[・、]?)+[ 　]+")

# 県の外の座標を、どこまで許すか（km）。
#
# 座標は名前で引いたもので、**県を絞っていない検索**が混じっています。
# 一覧の県の外に落ちた座標を見ると、ありふれた名前が別の県の同名に
# 当たっていました。
#
#   鳥取県「長谷寺」 → 広島県の長谷寺
#   神奈川県「本覚寺」 → 茨城県の本覚寺
#   山口県「薬師堂」 → 福岡県の薬師堂
#
# 一方で、県境のすぐ外にある正しい座標もあります（大分県「村上医家史料館」
# は中津市で、福岡県のエリアのほうが近い）。一覧の県のエリアから
# この距離までは、県境ぎわとして採ります。
BORDER_KM = 15.0

# 催し・季節の語。**名前の後ろに付いた部分**を外すのに使います。
EVENT_WORD = re.compile(
    r"(祭り?|まつり|フェスタ?|フェスティバル|フェア|イベント|ライトアップ|"
    r"イルミネーション|展示会|特別展|企画展|テーマ展|収蔵品展|写真展|作品展|"
    r"[^発]展$|マルシェ|朝市|花火|大会|コンサート|ライブ|演奏会|公演|"
    r"体験|ツアー|教室|講座|ワークショップ|ウォーク|ウォーキング|"
    r"(?<!ギャ)ラリー|スタンプ|キャンペーン|開き|(日曜|土曜|朝|夜|蚤の|骨董|陶器|植木|露天)市|週間|ウィーク|月間|"
    r"見頃|開花|新緑|紅葉狩り|雪見|観月|夜祭|宵|"
    r"\d{4}|[0-9０-９]+(年|月|日|回)|第[0-9０-９一二三四五六七八九十]+回)")

# 名前の後ろに付いた花・季節。場所はその前の部分です。
SEASON_TAIL = re.compile(
    r"の(桜|さくら|サクラ|しだれ桜|枝垂れ桜|夜桜|梅|紅葉|もみじ|藤|ふじ|"
    r"つつじ|ツツジ|あじさい|アジサイ|紫陽花|菜の花|ひまわり|コスモス|"
    r"チューリップ|イチョウ|銀杏|ハス|蓮|水芭蕉|ミズバショウ|カタクリ|"
    r"ニッコウキスゲ|アヤメ|花菖蒲|ショウブ|ボタン|牡丹|芝桜|シバザクラ|"
    r"ラベンダー|バラ|ばら|ヤマザクラ|山桜|雪景色|雪|新緑|紅葉狩り|オコジョ|ホタル|蛍)$")


# 場所の名前の終わり。催しの部分を外したあとに、これで終わっていなければ、
# 残ったのは場所ではありません（「挑戦・体験・発見！フォトロゲイニング」
# → 「挑戦」）。
PLACE_END = re.compile(
    r"(館|園|場|寺|院|社|宮|堂|山|岳|川|湖|池|沼|滝|城|跡|址|公園|高原|温泉|"
    r"湯|島|岬|浜|海岸|峠|谷|渓|峡|橋|庭園|里|森|村|家|住宅|邸|屋敷|"
    r"ミュージアム|ガーデン|パーク|センター|大路|通り|街道|道|台|丘|原|港|"
    r"塔|碑|像|墓|古墳|遺跡|灯台|ダム|牧場|農園|ファーム|酒造|蔵|醸造|"
    r"ホール|広場|スパ|プラザ|テラス|ランド|ワールド|村|町並み|街|坂|門|"
    r"窯|工房|カフェ|市場|駅|岩|石|木|杉|桜|松|洞|窟|泉|水|苑|殿|閣|亭|"
    r"ヒルズ|ビレッジ|ヴィレッジ|キャンプ場)$")

# 「〜館」「〜園」のように、催しの語を含んでも施設の名前になっているもの
# （ながおか花火館、まつり会館）。ここで切ると「道の駅」だけが残ります。
FACILITY_END = re.compile(
    r"(館|園|場|センター|ミュージアム|ホール|会館|公園|の里|村|ギャラリー)$")


def eventish(p):
    return bool(EVENT_WORD.search(p) or SEASON_TAIL.search(p)) and \
        not FACILITY_END.search(p)


def simplify(raw):
    """名前から、催し・季節・注の部分を外します。外した結果が無ければ None。

    外すのは**後ろに付いた部分だけ**です。「新緑祭」のように名前そのものが
    催しのものは、外したら何も残らないので None（入れない）になります。
    """
    s = unicodedata.normalize("NFKC", raw or "").strip()
    s = re.sub(r"^【[^】]*】\s*", "", s)
    s = DESIGNATION.sub("", s)
    s = re.sub(r"\s*【[^】]*】\s*", " ", s).strip()
    # 「テラマチマルシェ@高橋まゆみ人形館」：@ の後ろが場所です。
    if "@" in s:
        head, _, tail = s.partition("@")
        if EVENT_WORD.search(head) and tail.strip():
            s = tail.strip()
    # 括弧の注と「」の副題（「」の中は、店や催しの名前のことが多い）。
    s = re.sub(r"\s*[（(][^）)]*[）)]", "", s).strip()
    s = re.sub(r"\s*[「『][^」』]*[」』]", "", s).strip() or s
    # ～副題～。**かなの後ろの「～」は伸ばす音**です（家族湯ゆぅ～ゆぅ～）。
    # ただし中身に漢字や英字があれば副題です（～夏木山～、～saikouen～）。
    def _sub(m):
        inner = m.group(1)
        before = s[m.start() - 1] if m.start() else ""
        if re.fullmatch(r"[ぁ-んァ-ンー]*", inner) and re.match(r"[ぁ-んァ-ンー]", before):
            return m.group(0)
        return ""
    s = re.sub(r"[〜~]([^〜~]*)(?:[〜~]|$)", _sub, s).strip()
    # 「五十崎凧博物館で凧作り・凧あげ体験」：「で」の前が場所です。
    m = re.match(r"(.+?(館|園|場|寺|神社|公園|城|山|島|温泉))で(.+)$", s)
    if m and EVENT_WORD.search(m.group(3)):
        s = m.group(1)
    # 宣伝の文（「…がお楽しみ頂けます♪」）。最初のまとまりが場所なら、それだけ。
    if re.search(r"[♪！!。☆★]", s) and " " in s:
        head = s.split()[0]
        if PLACE_END.search(head) or len(head) >= 4:
            s = head
    before_cut = s
    # 空白で区切られた後ろに催しの語があれば、その前までを残す。
    # 残りが場所の名前で終わらなければ、さらに前で切ります
    # （「なべくら高原・森の家 春の森を歩こう 新緑祭」→「なべくら高原・森の家」）。
    parts = s.split()
    for i, p in enumerate(parts):
        if i > 0 and eventish(p):
            s = " ".join(parts[:i])
            for j in range(i, 0, -1):
                if PLACE_END.search(" ".join(parts[:j])):
                    s = " ".join(parts[:j])
                    break
            break
    # 「・」で区切られたまとまりの、催しの語がある所から後ろを外す。
    subs = s.split("・")
    for i, p in enumerate(subs):
        if i > 0 and eventish(p):
            s = "・".join(subs[:i])
            break
    # 後ろの「の桜」「周辺」、市町村の名前（「荒井家住宅 矢板市」）。
    s = SEASON_TAIL.sub("", s).strip()
    event_cut = s != before_cut
    s = re.sub(r"(周辺|付近|一帯)$", "", s).strip()
    # 「村」は名前の一部のことが多いので外しません（道の駅 すず塩田村）。
    t = re.sub(r"\s+\S+[市町区]$", "", s).strip()
    if len(t) >= 2 and t not in ("道の駅",):
        s = t
    s = SEASON_TAIL.sub("", s).strip()
    s = re.sub(r"\s+\S$", "", s).strip()   # 伸ばす音で切れた1文字
    s = s.strip(" 　・、,")
    if len(s) < 2:
        return None
    # 名前そのものが催し（外したら場所が残らない）。
    if eventish(s) or s.endswith(AN_EVENT):
        return None
    # 外したのに、場所の名前で終わっていない。2文字しか残らないものは
    # 地名です（仙台・青葉まつり → 仙台）。
    if event_cut and (not PLACE_END.search(s) or len(s) <= 2):
        return None
    return s


def category_of(name):
    if is_ropeway(name):
        return "ロープウェイ"
    for suffixes, cat in WIDE_BY_SUFFIX:
        if name.endswith(suffixes):
            return cat
    if name.endswith("高原"):
        return "高原"
    # 「〇〇岡山」「〇〇富山」は県の名前で、山ではありません。
    if name.endswith(("岡山", "富山", "和歌山", "山口", "高山", "郡山")):
        return "観光名所"
    for suffix, cat in SUFFIX_CATEGORY:
        if name.endswith(suffix):
            return cat
    return "観光名所"


def spot_id(pref, name):
    h = hashlib.sha1(f"geo:{pref}/{name}".encode("utf-8")).hexdigest()[:10]
    return f"gc-{h}"


# --- xlsx を読む（標準ライブラリだけ） ---------------------------------------

_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def read_sheets(path):
    """{シート名: [{"A": 値, "B": 値, ...}, ...]}（1行目は見出しなので外す）"""
    z = zipfile.ZipFile(path)
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target = {r.get("Id"): r.get("Target") for r in rels}
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        ss = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in ss.findall("m:si", _NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{_NS['m']}}}t")))
    out = {}
    for sh in wb.find("m:sheets", _NS):
        rid = sh.get(f"{{{_R}}}id")
        p = target[rid].lstrip("/")
        p = p if p.startswith("xl/") else "xl/" + p
        root = ET.fromstring(z.read(p))
        rows = []
        for r in root.iter(f"{{{_NS['m']}}}row"):
            row = {}
            for c in r.findall("m:c", _NS):
                col = re.match(r"[A-Z]+", c.get("r")).group()
                t = c.get("t")
                if t == "inlineStr":
                    v = "".join(x.text or "" for x in c.iter(f"{{{_NS['m']}}}t"))
                else:
                    ve = c.find("m:v", _NS)
                    v = ve.text if ve is not None else None
                    if t == "s" and v is not None:
                        v = shared[int(v)]
                row[col] = v
            rows.append(row)
        out[sh.get("name")] = rows[1:]
    return out


def to_float(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v


# --- 一覧から、入れる候補を作る ----------------------------------------------

def collect(sheets):
    """入れる候補と、入れない理由の数え。

    候補は {pref, name, raw, lat, lng, geo} です。同じ県・同じ名前（外した
    あと）は1つにまとめます。

    **「まとめ名（代表名）」の列は使いません。** 名前の頭が同じものを機械的に
    まとめた列で、別々の場所が1つになっていました。

      徳島県立近代美術館・徳島県立博物館 …      → 「徳島県立」
      天然温泉・極楽湯、天然温泉・多気の湯 …   → 「天然温泉」
      高梁市武家屋敷・旧埴原家 …               → 「高梁市武家屋敷・旧」

    しかも代表名の行が一覧に無い270組は、座標が**メンバーの平均**でした。
    平均は、どの場所でもない点です（座標を作らない、の原則に反します）。
    代わりに1行ずつ simplify() で催しの部分を外し、外したあとの名前で
    まとめます。座標は、まとめた行の**どれか1つの実際の座標**です。
    """
    why = collections.Counter()
    rows = []
    for r in sheets.get("観光地一覧", []):
        rows.append((r.get("A"), r.get("B"), r.get("C"), r.get("D"),
                     r.get("E"), r.get("F")))
    for r in sheets.get("Web調査結果", []):
        if r.get("C") != "取得":
            continue
        if r.get("F") not in ("高", "中"):
            why["Web調査の確度が低い"] += 1
            continue
        rows.append((r.get("A"), r.get("B"), r.get("D"), r.get("E"),
                     "Web調査", r.get("B")))

    groups = collections.OrderedDict()
    for pref, raw, la, ln, geo, searched in rows:
        lat, lng = to_float(la), to_float(ln)
        if not pref or not raw or lat is None or lng is None:
            why["座標が無い"] += 1
            continue
        if not (20 <= lat <= 46 and 122 <= lng <= 154):
            why["座標が日本の外"] += 1
            continue
        text = unicodedata.normalize("NFKC", raw).strip()
        if CLOSED.search(text) or CLOSED_WORD.match(text):
            why["閉店・閉館の札"] += 1
            continue
        if SHOP.search(text) or LODGING.search(text) or BUSINESS.search(text):
            why["店・宿・事業者"] += 1
            continue
        name = simplify(text)
        if not name:
            why["催しだけの名前"] += 1
            continue
        if SPORTS.search(name) or SPORTS.search(text):
            why["運動施設・公共施設"] += 1
            continue
        if NOT_PLACE.search(name):
            why["場所ではない（コース・芸能など）"] += 1
            continue
        if (looks_unusable(name, lat, lng) or name.endswith(NOT_A_DESTINATION)
                or SHOP.search(name) or LODGING.search(name)):
            why["行き先にならない名前"] += 1
            continue
        searched = unicodedata.normalize("NFKC", searched or "").strip()
        groups.setdefault((pref, n(name)), []).append(
            {"pref": pref, "name": name, "raw": raw, "lat": lat, "lng": lng,
             "geo": geo, "searched": searched})

    out, by_coord = [], collections.defaultdict(set)
    for (pref, _), g in groups.items():
        if len(g) > 1:
            why["一覧の中で重複（まとめた）"] += len(g) - 1
        # どの行の座標を使うか。**その名前そのものの行**があればそれ
        # （「なべくら高原・森の家」の行）、無ければその名前で検索した行、
        # それも無ければ最初の行です。催しの名前で検索した座標は、
        # 会場が場所の中の別の点のことがあります。
        best = next((c for c in g
                     if unicodedata.normalize("NFKC", c["raw"]).strip() == c["name"]),
                    None) or next((c for c in g if n(c["searched"]) == n(c["name"])),
                                  None) or g[0]
        # まとめた行どうしが離れていたら、同じ名前の別の場所です。
        # どれか1つに決められないので、名前そのものの行が無ければ入れません。
        far = any(km(best["lat"], best["lng"], c["lat"], c["lng"]) > 5 for c in g)
        if far and unicodedata.normalize("NFKC", best["raw"]).strip() != best["name"]:
            why["同じ名前が離れた場所に複数（決められない）"] += 1
            continue
        out.append(best)
        by_coord[(round(best["lat"], 5), round(best["lng"], 5))].add(n(best["name"]))

    # 同じ座標を、名前の違う3件以上が分け合っている。
    kept = []
    for c in out:
        if len(by_coord[(round(c["lat"], 5), round(c["lng"], 5))]) >= 3:
            why["同じ座標を3つ以上の名前が共有（取り違えの疑い）"] += 1
            continue
        kept.append(c)
    return kept, why


def main(path, write):
    sheets = read_sheets(path)
    print("シート: " + "、".join(f"{k} {len(v)}行" for k, v in sheets.items()))
    cands, why = collect(sheets)
    print(f"入れる候補（まとめたあと）{len(cands)}件")

    with open(os.path.join(WEB, "kb", "regions.json"), encoding="utf-8") as f:
        regions_doc = json.load(f)
    locator = PrefectureLocator(regions_doc["regions"])
    region_pref = {r["id"]: r["prefecture"] for r in regions_doc["regions"]}

    shards = load_shards()
    existing = [s for doc in shards.values() for s in doc["spots"]
                if s.get("src") != SRC]

    # 収録の県の食い違い（listedIn）を、この一覧で直します。
    # 同じ名前が一覧の県の中にあれば、食い違ったほうを外します。
    by_listed = collections.defaultdict(list)
    for s in existing:
        if s.get("listedIn"):
            by_listed[(s["listedIn"], n(s["name"]))].append(s)
    fix_ids = set()
    for c in cands:
        olds = by_listed.get((c["pref"], n(c["name"])))
        if olds and locator.in_prefecture(c["lat"], c["lng"], c["pref"])[0]:
            for s in olds:
                fix_ids.add(s["id"])
    existing = [s for s in existing if s["id"] not in fix_ids]
    why["収録の県の食い違いを、この一覧の座標で直した"] = len(fix_ids)

    grid = collections.defaultdict(list)
    for s in existing:
        grid[(round(s["lat"] / 0.05), round(s["lng"] / 0.05))].append(s)
    named_here = {(s["regionId"], n(s["name"])) for s in existing}

    add, used_sources = [], set()
    for c in cands:
        name, lat, lng = c["name"], c["lat"], c["lng"]
        gx, gy = round(lat / 0.05), round(lng / 0.05)
        near = [x for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                for x in grid[(gx + dx, gy + dy)]]
        probe = {"name": name, "lat": lat, "lng": lng}
        if any(same_place(probe, s, km(lat, lng, s["lat"], s["lng"]))
               for s in near):
            why["すでに収録にある"] += 1
            continue
        # ごく近くに、名前を含む・含まれるものがある（同じ場所の別の書き方）。
        #
        #   鎌倉大仏殿高徳院  ↔  高徳院（鎌倉大仏）     （同じ座標）
        #
        # same_place は名前の形で見るので、前に飾りが付いた書き方を
        # 見落としました。300m 以内で、3文字以上の核が含まれていれば同じと
        # みなします（同じ建物の別の施設は、核が含まれないので残ります）。
        core = n(re.sub(r"[（(][^）)]*[）)]", "", name))
        if len(core) >= 3 and any(
                km(lat, lng, s["lat"], s["lng"]) <= 0.3 and (
                    (lambda o: len(o) >= 3 and (o in core or core in o))(
                        n(re.sub(r"[（(][^）)]*[）)]", "", s["name"]))))
                for s in near):
            why["すでに収録にある（近くて名前を含む）"] += 1
            continue
        region = locator.region_near(lat, lng)
        if km(lat, lng, region["lat"], region["lng"]) > MAX_PLACE_KM:
            why["エリアから遠すぎて置けない"] += 1
            continue
        inside = (locator.in_prefecture(lat, lng, c["pref"])[0]
                  or region_pref.get(region["id"]) == c["pref"])
        if not inside and locator.dist_to_prefecture(
                lat, lng, c["pref"]) > BORDER_KM:
            why["県の外の同名に当たった疑い（県境から遠い）"] += 1
            continue
        if (region["id"], n(name)) in named_here:
            why["同じエリアに同名がすでにある"] += 1
            continue
        spot = {
            "id": spot_id(c["pref"], name),
            "regionId": region["id"],
            "name": name,
            "category": category_of(name),
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            # 一覧は1つだけです。定番かどうかを決める材料がありません。
            "fame_tier": "hidden",
            "geo": c["geo"],
            "src": SRC,
        }
        if not inside:
            spot["listedIn"] = c["pref"]
        if name != unicodedata.normalize("NFKC", c["raw"]).strip():
            # 外す前の名前を残します（見直しのため）。
            spot["listedAs"] = c["raw"]
        add.append(spot)
        named_here.add((region["id"], n(name)))
        grid[(gx, gy)].append(spot)
        if c["geo"] in GEO_SOURCES:
            used_sources.add(c["geo"])

    why["足す"] = len(add)
    why["  うち名前を簡略化"] = sum(1 for s in add if s.get("listedAs"))
    why["  うち県の食い違い"] = sum(1 for s in add if s.get("listedIn"))
    print("\n内訳:")
    for k, v in why.most_common():
        print(f"  {k}: {v}件")
    print()
    for cat, cnt in collections.Counter(s["category"] for s in add).most_common(25):
        print(f"  {cat} {cnt}件")
    print("  取得元: " + "、".join(
        f"{k} {v}" for k, v in collections.Counter(s["geo"] for s in add).most_common()))

    if "--show" in sys.argv:
        import random
        random.seed(int(os.environ.get("SEED", "3")))
        pool = add
        if os.environ.get("SIMPLIFIED"):
            pool = [s for s in add if s.get("listedAs")]
        print("\n無作為に40件（一覧の名前 → 入れる名前 / 分類 / 取得元）:")
        for s in random.sample(pool, min(40, len(pool))):
            print(f"  {s.get('listedAs', s['name'])!r} → {s['name']!r} "
                  f"[{s['category']}] {s['geo']}")

    if not write:
        print("\n--write を付けると書き戻します。")
        return

    # 前回のぶんと、県の食い違いを直したぶんを取り除きます。
    removed = 0
    for p, doc in shards.items():
        keep = [x for x in doc["spots"]
                if x.get("src") != SRC and x["id"] not in fix_ids]
        removed += len(doc["spots"]) - len(keep)
        if len(keep) != len(doc["spots"]):
            doc["spots"] = keep
            with open(p, "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    for p in glob.glob(os.path.join(WEB, "kb", "spots-gc*.json")):
        os.remove(p)
        shards.pop(p, None)
    if removed:
        print(f"  前回のぶんと直したぶん {removed}件 を取り除きました")

    per_file = 2500
    for i in range(0, len(add), per_file):
        chunk = add[i:i + per_file]
        p = os.path.join(WEB, "kb", f"spots-gc{i // per_file:02d}.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"spots": chunk}, f, ensure_ascii=False,
                      separators=(",", ":"))
        shards[p] = {"spots": chunk}

    sources = [PREF_SOURCE]
    for g in sorted(used_sources):
        if GEO_SOURCES[g] not in sources:
            sources.append(GEO_SOURCES[g])
    total = register(shards, regions_doc, sources)
    print(f"\n収録 {total}件になりました。")
    print("このあと tools/reshard_kb.py を走らせて、県ごとに並べ直します。")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        raise SystemExit(__doc__)
    main(args[0], "--write" in sys.argv)
