# -*- coding: utf-8 -*-
"""国土数値情報（鉄道 N02・バス停留所 P11）から、経路APIが使えない区間の
「なんとなくの目安」用に、停留所の位置だけを取り出す。

なぜ要るか
  Routes API は、バスしかない区間や登山道では ZERO_RESULTS を返す。
  そのとき今までは出発地→目的地の直線距離だけで見積もっていたが、
  たとえば富士山五合目のように「バス停までは速い公共交通、そこから先は
  徒歩（登山道）」という区間を、ぜんぶ同じ速さで計算すると大きく外れる。
  停留所の実位置が分かれば、「最寄り停留所まで徒歩→停留所間は目安の速さ
  →最寄り停留所から先は徒歩」と分けて見積もれる（js/stops.js）。

出典データについての注意（作成年）
  ・鉄道（N02）: 2008年度版。新しい路線・駅（延伸・新駅）は含まれず、
    廃線もそのまま残っている。**あくまで「だいたいの位置」の目安。**
  ・バス停留所（P11）: 2012年3月時点。停留所そのものの位置は駅ほど
    頻繁には動かないが、これも同様に目安止まり。
  港湾（C02）・ヘリポート（C28）は今回は取り込まない
  （登山・徒歩ラストマイルの目安には使わないため）。

出力
  kb/stops-rail.json … 全国の駅（約1万件、そのまま収録）
  kb/stops-bus.json  … 収録済みスポット・エリアの駅から半径
                        BUS_RADIUS_KM 以内のバス停だけに絞って収録
                        （全国では数十万件になり、静的サイトに乗せる
                        大きさではないため）

  どちらも同じ形: {"year": 年, "stops": [[lat, lng, name], ...]}

使い方
  python3 tools/build_stops.py rail  <N02-08.xml> [出力先]
  python3 tools/build_stops.py bus   <P11のzipを集めたディレクトリ> [出力先]
  python3 tools/build_stops.py patch <kb/stops-rail.json>

  patch は、出来上がった駅データに tools/station_updates.py の差分だけを
  あてます（元のXMLが手元に無くても、差分の追記を反映できます）。
"""
import json
import math
import os
import re
import sys
import zipfile

import station_updates

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)

BUS_RADIUS_KM = 8.0

# バス停は全国で25万件を超え、収録スポット全体（1.5万件超）を基準に
# 絞ってもまだ数十万件が残ってしまう（静的サイトに乗せる大きさではない）。
# このデータの使いどころは「登山道など、駅からもバスからも切れた
# 徒歩ラストマイル」なので、山まわりのカテゴリだけを基準にする。
MOUNTAIN_CATEGORIES = {"登山", "山", "高原", "渓谷"}

POINT_RE = re.compile(
    r'<jps:GM_Point id="([^"]+)">\s*<jps:GM_Point\.position>\s*'
    r'<jps:DirectPosition>\s*<DirectPosition\.coordinate>'
    r'([\d.]+)\s+([\d.]+)</DirectPosition\.coordinate>')

CURVE_RE = re.compile(r'<jps:GM_Curve id="([^"]+)">(.*?)</jps:GM_Curve>', re.S)
FIRST_REF_RE = re.compile(r'GM_PointRef\.point idref="([^"]+)"')

EB03_RE = re.compile(r'<ksj:EB03[^>]*>(.*?)</ksj:EB03>', re.S)
LOC_RE = re.compile(r'<ksj:LOC idref="([^"]+)"')
STN_RE = re.compile(r'<ksj:STN>(.*?)</ksj:STN>')

ED01_RE = re.compile(r'<ksj:ED01[^>]*>(.*?)</ksj:ED01>', re.S)
POS_RE = re.compile(r'<ksj:POS idref="([^"]+)"')
BSN_RE = re.compile(r'<ksj:BSN>(.*?)</ksj:BSN>')


def parse_points(text):
    pts = {}
    for pid, lat, lng in POINT_RE.findall(text):
        pts[pid] = (float(lat), float(lng))
    return pts


def haversine_km(a, b):
    r = 6371.0
    dlat = math.radians(b[0] - a[0])
    dlng = math.radians(b[1] - a[1])
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlng / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(h)))


def build_rail(xml_path, out_path):
    with open(xml_path, encoding="utf-8", errors="replace") as f:
        text = f.read()

    points = parse_points(text)

    curve_pt = {}
    for cid, body in CURVE_RE.findall(text):
        rm = FIRST_REF_RE.search(body)
        if rm and rm.group(1) in points:
            curve_pt[cid] = points[rm.group(1)]

    seen = {}
    for body in EB03_RE.findall(text):
        loc = LOC_RE.search(body)
        stn = STN_RE.search(body)
        if not loc or not stn:
            continue
        pt = curve_pt.get(loc.group(1))
        if not pt:
            continue
        name = stn.group(1).strip()
        key = (name, round(pt[0], 3), round(pt[1], 3))
        if key not in seen:
            seen[key] = [round(pt[0], 5), round(pt[1], 5), name]

    stops = sorted(seen.values(), key=lambda s: (s[0], s[1]))
    # 2008年度のままでは、新幹線の駅が無く、廃線の駅が残ります。
    stops = station_updates.apply(stops)
    write_out(out_path, 2008, stops)
    print(f"駅 {len(stops)}件 → {out_path}")


def parse_bus_zip_bytes(data):
    """1都道府県ぶんの P11 zip（バイト列）から、バス停の座標と名前を返す。"""
    z = zipfile.ZipFile(data)
    xml_name = next(n for n in z.namelist() if n.lower().endswith(".xml")
                     and not n.startswith("KS-META"))
    text = z.read(xml_name).decode("utf-8", errors="replace")

    points = parse_points(text)
    out = []
    for body in ED01_RE.findall(text):
        pos = POS_RE.search(body)
        bsn = BSN_RE.search(body)
        if not pos or not bsn:
            continue
        pt = points.get(pos.group(1))
        if not pt:
            continue
        out.append((pt[0], pt[1], bsn.group(1).strip(), pos.group(1)))
    return out


def load_anchor_points():
    """山まわりのカテゴリのスポットだけを基準点にする（上のコメント参照）。"""
    anchors = []
    for name in sorted(os.listdir(os.path.join(WEB, "kb"))):
        if not name.startswith("spots-") or not name.endswith(".json"):
            continue
        with open(os.path.join(WEB, "kb", name), encoding="utf-8") as f:
            for s in json.load(f)["spots"]:
                if s["category"] in MOUNTAIN_CATEGORIES:
                    anchors.append((s["lat"], s["lng"]))
    return anchors


def build_grid(points, cell_deg=0.05):
    grid = {}
    for p in points:
        key = (round(p[0] / cell_deg), round(p[1] / cell_deg))
        grid.setdefault(key, []).append(p)
    return grid


def near_any_anchor(pt, grid, cell_deg, radius_km):
    cx, cy = round(pt[0] / cell_deg), round(pt[1] / cell_deg)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for a in grid.get((cx + dx, cy + dy), ()):
                if haversine_km(pt, a) <= radius_km:
                    return True
    return False


def build_bus(zips_dir, out_path):
    anchors = load_anchor_points()
    cell_deg = 0.05
    grid = build_grid(anchors, cell_deg)
    print(f"収録スポット・エリアの座標 {len(anchors)}件から、"
          f"半径{BUS_RADIUS_KM}km以内のバス停だけを残します。")

    seen = {}
    total_raw = 0
    for name in sorted(os.listdir(zips_dir)):
        if not name.lower().endswith(".zip"):
            continue
        path = os.path.join(zips_dir, name)
        with open(path, "rb") as f:
            stops = parse_bus_zip_bytes(f)
        total_raw += len(stops)
        for lat, lng, bsn, pos_id in stops:
            if not near_any_anchor((lat, lng), grid, cell_deg, BUS_RADIUS_KM):
                continue
            key = (round(lat, 4), round(lng, 4))
            if key not in seen:
                seen[key] = [round(lat, 5), round(lng, 5), bsn]
        print(f"  {name}: 累計 {len(seen)}件（元 {total_raw}件）")

    stops = sorted(seen.values(), key=lambda s: (s[0], s[1]))
    write_out(out_path, 2012, stops)
    print(f"バス停 {len(stops)}件（全国 約{total_raw}件のうち収録エリア周辺のみ）"
          f" → {out_path}")


def write_out(path, year, stops):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"year": year, "stops": stops}, f, ensure_ascii=False,
                   separators=(",", ":"))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    kind, src = sys.argv[1], sys.argv[2]
    if kind == "rail":
        out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(WEB, "kb", "stops-rail.json")
        build_rail(src, out)
    elif kind == "bus":
        out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(WEB, "kb", "stops-bus.json")
        build_bus(src, out)
    elif kind == "patch":
        with open(src, encoding="utf-8") as f:
            doc = json.load(f)
        doc["stops"] = station_updates.apply(doc["stops"])
        write_out(src, doc.get("year", 2008), doc["stops"])
        print(f"差分をあてました → {src}")
    else:
        print(__doc__)
        sys.exit(1)
