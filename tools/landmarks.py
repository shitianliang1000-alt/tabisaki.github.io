# -*- coding: utf-8 -*-
"""観光資源台帳を外したときに落ちた、著名な行き先を書き戻す。

台帳（日本観光振興協会）は再配布の条件がはっきりしないので収録から
外しました（tools/drop_daicho.py）。ただ、そこにしか入っていなかった
場所の中には、熊本城・二条城・知床五湖・縄文杉のように、
**日本の旅行先として外せないもの**が含まれていました。外したままだと
「熊本へ行きたい」に熊本城が出ません。

ここに置くのは、台帳の写しではありません。

  ・場所の名前と緯度経度は事実であって、誰かの著作物ではありません。
  ・説明文はこのアプリで書き起こしたものです（台帳の文面は使いません）。
  ・件数も台帳の選び方に合わせていません。広く知られた行き先だけを、
    こちらの判断で選んでいます。

座標は約100m精度です。営業時間・料金は入れていません（分類ごとの
既定値が使われます）。確かめられないものを、確かめたように置かないためです。

    python3 tools/landmarks.py --check
    python3 tools/landmarks.py --write
"""
import glob
import json
import os
import sys

from dedupe_spots import same_place

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)

# (name, category, lat, lng, fame, region_hint, description)
#   region_hint … "都道府県" か "都道府県/エリア名"。
#     エリア名まで書くと、そのエリアに入れます。直線距離でいちばん近い
#     エリアが、行き方として近いとは限らないためです（知床五湖は
#     斜里町側で、羅臼町は知床峠の反対側。冬は峠が閉まります）。
LANDMARKS = [
    # --- 北海道 ---
    ("宗谷岬", "観光名所", 45.5231, 141.9367, "major", "北海道",
     "日本最北端の岬。三角の碑の先はオホーツク海で、晴れた日には"
     "サハリンの島影が見えます。"),
    ("知床五湖", "湖", 44.1122, 145.0894, "major", "北海道/斜里町",
     "原生林の中に点在する5つの湖。高架木道からは知床連山と"
     "オホーツク海を一度に見渡せます。"),
    ("白金 青い池", "湖", 43.4939, 142.6300, "major", "北海道",
     "立ち枯れた白樺と、青く濁った水面。人工の堰き止め池ですが、"
     "水に溶けた成分が光を散らしてこの色になります。"),
    ("五稜郭", "史跡", 41.7969, 140.7569, "major", "北海道",
     "星形の堀をもつ幕末の城郭。隣のタワーから見ると、形がよく分かります。"),
    ("旭山動物園", "動物園", 43.7686, 142.4806, "major", "北海道",
     "動きを見せる展示で知られる市営動物園。ペンギンの散歩は冬だけです。"),

    # --- 東北 ---
    ("中尊寺金色堂", "寺院", 39.0011, 141.0989, "major", "岩手県",
     "金箔と螺鈿で覆われた阿弥陀堂。覆堂の中に、建立当時の姿で残ります。"),
    ("山寺 立石寺", "寺院", 38.3122, 140.4367, "major", "山形県",
     "岩山を1015段の石段で登る古刹。上りきった五大堂から谷が一望できます。"),
    ("松島", "観光名所", 38.3697, 141.0603, "major", "宮城県",
     "湾に浮かぶ260余りの島。遊覧船か、四大観と呼ばれる高台から眺めます。"),
    ("十和田湖", "湖", 40.4667, 140.8833, "major", "青森県",
     "カルデラにたたえられた湖。奥入瀬渓流はここから流れ出します。"),
    ("角館 武家屋敷", "町並み", 39.5983, 140.5636, "major", "秋田県",
     "黒板塀の続く武家町。しだれ桜が塀ごしに枝を垂らします。"),

    # --- 関東 ---
    ("日光東照宮", "神社", 36.7581, 139.5992, "major", "栃木県",
     "極彩色の彫刻で埋め尽くされた徳川家康の霊廟。陽明門が正面に立ちます。"),
    ("鎌倉大仏 高徳院", "寺院", 35.3167, 139.5358, "major", "神奈川県",
     "露天に座す高さ11mの阿弥陀如来像。胎内に入れます。"),
    ("川越 蔵造りの町並み", "町並み", 35.9256, 139.4856, "major", "埼玉県",
     "黒漆喰の蔵が並ぶ通り。時の鐘が町のしるしです。"),

    # --- 中部 ---
    ("富士山本宮浅間大社", "神社", 35.2278, 138.6103, "major", "静岡県",
     "全国の浅間神社の総本宮。境内の湧玉池は富士の伏流水です。"),
    ("三保松原", "海岸", 35.0169, 138.5219, "major", "静岡県",
     "松林ごしに富士を望む砂浜。羽衣伝説の舞台です。"),
    ("城ヶ崎海岸", "海岸", 34.8942, 139.1361, "major", "静岡県",
     "溶岩が波に削られた断崖。吊橋から真下の海が見えます。"),
    ("掛川城", "城", 34.7772, 138.0147, "major", "静岡県",
     "木造で復元された天守。隣の二の丸御殿は現存の建物です。"),
    ("白川郷 合掌造り集落", "町並み", 36.2578, 136.9061, "major", "岐阜県",
     "急勾配の茅葺屋根が並ぶ山あいの集落。展望台から全景を見渡せます。"),
    ("苗木城跡", "城", 35.4939, 137.4772, "major", "岐阜県",
     "巨岩の上に柱を組んで建てられた山城。展望台から恵那山と木曽川を望みます。"),
    ("上高地 河童橋", "自然", 36.2506, 137.6339, "major", "長野県",
     "梓川にかかる吊橋。正面に穂高連峰が立ちます。"),
    ("松本城", "城", 36.2384, 137.9689, "major", "長野県",
     "黒漆の下見板をまとう現存天守。北アルプスを背に立ちます。"),
    ("兼六園", "庭園", 36.5622, 136.6625, "major", "石川県",
     "加賀藩の大名庭園。冬は雪吊りが池をかこみます。"),
    ("七尾城跡", "城", 36.9925, 136.9578, "major", "石川県/七尾市",
     "尾根を段々に削った山城の跡。石垣と、能登の海を見下ろす眺めが残ります。"),
    ("山中温泉", "温泉", 36.2436, 136.3703, "known", "石川県",
     "鶴仙渓に沿う温泉町。あやとりはしと総湯が中心です。"),
    ("山代温泉", "温泉", 36.2900, 136.3936, "known", "石川県",
     "古総湯の建物が町の真ん中に立つ湯の町。九谷焼の窯元が周りにあります。"),

    # --- 近畿 ---
    ("元離宮二条城", "城", 35.0142, 135.7481, "major", "京都府",
     "徳川将軍の京都の居城。二の丸御殿の障壁画と、鳴る廊下で知られます。"),
    ("平安神宮", "神社", 35.0161, 135.7822, "major", "京都府",
     "朱塗りの大極殿と大鳥居。裏手の神苑は池をめぐる回遊式庭園です。"),
    ("京都国立博物館", "博物館", 34.9900, 135.7728, "major", "京都府",
     "京都の仏教美術と工芸を集めた館。赤煉瓦の明治古都館が向かいに建ちます。"),
    ("京都鉄道博物館", "博物館", 34.9869, 135.7386, "major", "京都府",
     "蒸気機関車から新幹線まで並ぶ車両館。扇形車庫が屋外に残ります。"),
    ("松尾大社", "神社", 34.9997, 135.6850, "major", "京都府/京都市",
     "醸造の神を祀る古社。境内に酒樽が積まれています。"),
    ("三井寺 園城寺", "寺院", 35.0133, 135.8531, "major", "滋賀県",
     "琵琶湖を見下ろす天台寺門宗の総本山。晩鐘は近江八景のひとつです。"),
    ("奈良国立博物館", "博物館", 34.6853, 135.8322, "major", "奈良県",
     "奈良の仏像を通年で見られる館。秋には正倉院展が開かれます。"),
    ("熱海温泉", "温泉", 35.0961, 139.0717, "major", "静岡県",
     "海に面した斜面に宿が並ぶ温泉地。花火は年間を通して打ち上がります。"),

    # --- 中国・四国 ---
    ("鳥取城跡", "城", 35.5069, 134.2481, "known", "鳥取県",
     "久松山の斜面に石垣が残る城跡。天球丸の丸い石垣が珍しい形です。"),
    ("島根県立美術館", "美術館", 35.4622, 133.0447, "known", "島根県",
     "宍道湖に面した美術館。日没に合わせて閉館時刻が変わります。"),
    ("宇和島城", "城", 33.2200, 132.5658, "known", "愛媛県",
     "現存天守のひとつ。海に突き出した丘の上に建ちます。"),

    # --- 九州・沖縄 ---
    ("熊本城", "城", 32.8060, 130.7058, "major", "熊本県",
     "反り返る石垣で知られる城。地震からの修復が続いています。"),
    ("平戸城", "城", 33.3689, 129.5544, "known", "長崎県",
     "平戸瀬戸を見下ろす丘の城。海峡と港町を一望できます。"),
    ("縄文杉", "登山", 30.3286, 130.5417, "major", "鹿児島県",
     "屋久島の奥にある巨大な杉。往復10時間ほどの山道の先にあります。"),
]


# 台帳を外したときに、スポットが0件になって消えたエリア。
# ここに書き戻す行き先があるので、エリアごと戻します。
# （知床五湖は斜里町側です。羅臼町は峠を越えた反対側なので、
#  近いという理由だけで寄せると、旅程の移動時間が狂います。）
RESTORE_REGIONS = [
    {
        "id": "n1116", "name": "斜里町", "prefecture": "北海道",
        "prefectureId": "n1116", "hub": "tokyo",
        "lat": 44.13072, "lng": 145.00086,
        "station": "斜里町中心部",
        "stationLat": 44.13072, "stationLng": 145.00086,
        "genres": ["nature", "sea"], "spotCount": 0, "src": "external",
    },
]


def load_shards():
    out = {}
    for path in sorted(glob.glob(os.path.join(WEB, "kb", "spots-*.json"))):
        with open(path, encoding="utf-8") as f:
            out[path] = json.load(f)
    return out


def pick_region(regions, lat, lng, hint):
    """置き場所のエリア。"hint" が "県/エリア名" なら、そのエリアに入れます。"""
    prefecture, _, name = hint.partition("/")
    if name:
        for r in regions:
            if r["name"] == name and r.get("prefecture") == prefecture:
                return r
        return None
    best, best_d = None, None
    for r in regions:
        if prefecture and r.get("prefecture") != prefecture:
            continue
        d = (r["lat"] - lat) ** 2 + (r["lng"] - lng) ** 2
        if best_d is None or d < best_d:
            best, best_d = r, d
    return best


def main(write):
    shards = load_shards()
    existing = [s for doc in shards.values() for s in doc["spots"]]
    with open(os.path.join(WEB, "kb", "regions.json"), encoding="utf-8") as f:
        regions = json.load(f)

    known = {r["id"] for r in regions["regions"]}
    restored = [r for r in RESTORE_REGIONS if r["id"] not in known]
    regions["regions"].extend(restored)

    add, skip, orphan = [], [], []
    for name, cat, lat, lng, fame, pref, desc in LANDMARKS:
        # 表記ゆれも見ます。「角館 武家屋敷」と「角館武家屋敷」を
        # 別物として足すと、同じ場所が2件に増えます。
        probe = {"name": name, "lat": lat, "lng": lng}
        if any(same_place(probe, s) and abs(s["lat"] - lat) < 0.05
               and abs(s["lng"] - lng) < 0.05 for s in existing):
            skip.append(name)
            continue
        region = pick_region(regions["regions"], lat, lng, pref)
        if not region:
            orphan.append(f"{name}（{pref} に当たる収録エリアがありません）")
            continue
        add.append({
            "id": f"lm-{len(add) + 1}",
            "regionId": region["id"],
            "name": name,
            "category": cat,
            "lat": lat,
            "lng": lng,
            "fame_tier": fame,
            "description": desc,
        })

    if restored:
        print("戻すエリア: "
              + "、".join(f"{r['name']}（{r['prefecture']}）" for r in restored))
    print(f"書き戻す: {len(add)}件 / すでにある: {len(skip)}件")
    for s in add:
        r = next(r for r in regions["regions"] if r["id"] == s["regionId"])
        print(f"  {s['name']} → {r['name']}（{r.get('prefecture', '')}）")
    if orphan:
        print("\n置き場所が無いもの:")
        for o in orphan:
            print(f"  {o}")

    if not write:
        print("\n--write を付けると書き戻します。")
        return

    path = os.path.join(WEB, "kb", "spots-00.json")
    shards[path]["spots"].extend(add)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(shards[path], f, ensure_ascii=False, separators=(",", ":"))

    per_region = {}
    total = 0
    for p, doc in shards.items():
        total += len(doc["spots"])
        for s in doc["spots"]:
            per_region[s["regionId"]] = per_region.get(s["regionId"], 0) + 1

    for r in regions["regions"]:
        if "spotCount" in r:
            r["spotCount"] = per_region.get(r["id"], 0)
    with open(os.path.join(WEB, "kb", "regions.json"), "w", encoding="utf-8") as f:
        json.dump(regions, f, ensure_ascii=False, separators=(",", ":"))

    ipath = os.path.join(WEB, "kb", "index.json")
    with open(ipath, encoding="utf-8") as f:
        index = json.load(f)
    by_file = {os.path.basename(p): len(d["spots"]) for p, d in shards.items()}
    for shard in index.get("shards", []):
        if shard["file"] in by_file:
            shard["count"] = by_file[shard["file"]]
    if "counts" in index:
        index["counts"]["spots"] = total
        index["counts"]["regions"] = len(regions["regions"])
    with open(ipath, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    print(f"\n収録 {total}件 になりました。")


if __name__ == "__main__":
    main(write="--write" in sys.argv)
