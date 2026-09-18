#!/usr/bin/env python3
# coding: utf-8
"""バス停のデータを、緯度経度1度ごとのタイルに切り分ける。

    python3 tools/tile_stops.py [kb ディレクトリ]

なぜ切るのか
------------
kb/stops-bus.json は 65,606件・2.3MB（gzip でも 811KB）あります。
旅程1本で使うのは、立ち寄り先の周り数kmぶんだけです。全国の
バス停を読んでから3km圏内を探していました。

引きかたは座標です（最寄りの停留所）。座標で引くなら、地図の
タイルと同じように切れます。1度（約111km四方）で切ると 67枚になり、
旅程1本が触るのは1〜3枚（50〜300KB）です。

名前で引くとき（打ち込まれた停留所名）だけは、どのタイルにあるか
分からないので全部読みます。駅に当たらない名前を打たれたときだけ
なので、めったに起きません。

入れ物の形
----------
kb/stops-bus.json は**タイルの索引**になります。

    {"year": 2012, "tiles": [{"file": "stops-bus/35_139.json", "count": 5716,
                              "lat": 35, "lng": 139}]}

古い形（{"year":..., "stops":[...]}）もそのまま読めるようにしてあります
（js/stops-data.js）。索引に tiles が無ければ、これまでどおり全件と
して扱います。試験はその形のまま動きます。
"""

import io
import json
import os
import sys
import math


def main():
    kb_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "kb")
    src = os.path.join(kb_dir, "stops-bus.json")
    with io.open(src, encoding="utf-8") as f:
        doc = json.load(f)
    stops = doc.get("stops")
    if not stops:
        raise SystemExit("stops-bus.json に stops がありません（もう切ってある？）")

    tiles = {}
    for s in stops:
        key = (int(math.floor(s[0])), int(math.floor(s[1])))
        tiles.setdefault(key, []).append(s)

    out_dir = os.path.join(kb_dir, "stops-bus")
    os.makedirs(out_dir, exist_ok=True)
    dump = lambda obj: json.dumps(obj, ensure_ascii=False, separators=(",", ":"))

    index = []
    for (lat, lng) in sorted(tiles):
        part = tiles[(lat, lng)]
        name = "%d_%d.json" % (lat, lng)
        with io.open(os.path.join(out_dir, name), "w", encoding="utf-8") as f:
            f.write(dump({"stops": part}))
        index.append({"file": "stops-bus/" + name, "count": len(part),
                      "lat": lat, "lng": lng})

    with io.open(src, "w", encoding="utf-8") as f:
        f.write(dump({"year": doc.get("year"), "tiles": index}))

    total = sum(len(v) for v in tiles.values())
    if total != len(stops):
        raise SystemExit("件数が変わりました: %d → %d" % (len(stops), total))
    biggest = max(index, key=lambda x: x["count"])
    sys.stderr.write(
        "%d タイル / %d 停留所 / 索引 %.0fKB / 最大タイル %s %d件 %.0fKB\n"
        % (len(index), total, os.path.getsize(src) / 1024, biggest["file"],
           biggest["count"],
           os.path.getsize(os.path.join(kb_dir, biggest["file"])) / 1024))


if __name__ == "__main__":
    main()
