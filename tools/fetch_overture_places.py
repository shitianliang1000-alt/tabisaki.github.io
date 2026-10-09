# -*- coding: utf-8 -*-
"""Overture Maps の施設データ（places）から、日本の分だけを取り出す。

    python3 tools/fetch_overture_places.py            日本の範囲を保存
    python3 tools/fetch_overture_places.py --stats    保存したものの中身を数える

## なぜ Overture なのか

各都道府県の観光サイトの名前の一覧（xlsx）には座標がありません。ウィキペディア
と OpenStreetMap で座標を付けても、5万8千件のうち約9割が残りました。

ご依頼は「Google マップなどで調べて」でした。**Google マップは使えません。**

  ・ページを機械的に読むことは、規約で禁止されています
  ・API（Places・Geocoding）を使っても、結果の**保存**と、Google 以外の
    地図（このアプリは OpenStreetMap）での**表示**が、規約で認められて
    いません。4万件を保存して公開のリポジトリに入れると規約違反です

同じ目的（施設名から座標）で、**条件のはっきりした別のデータ**が Overture
Maps の places です。Meta・Microsoft などが提供するオープンな施設データで、
日本にも343万件あります。

## 利用条件

  ・ライセンス   CDLA Permissive 2.0（Meta・Microsoft ほか）／
                 Apache 2.0（Foursquare）／CC0 1.0（AllThePlaces）
  ・表示         「Overture Maps Foundation, overturemaps.org」
  ・共有の義務   ありません（OpenStreetMap の ODbL と違って、同じ条件で
                 共有する義務がありません）

  https://docs.overturemaps.org/attribution/

## 取り出しかた

places は16ファイル・10.2GB ですが、**日本のデータは最後の1ファイルに
集まっています**（位置順に並んでいるため）。DuckDB で範囲を指定して、
必要な列だけを読みます（S3 へ HTTPS で届きます。全部を落としません）。

保存するのは名前・座標・種類・住所・営業の状態・出どころだけです。
"""
import os
import re
import subprocess
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
OUT = os.path.join(WEB, "data", "overture")

BUCKET = "https://overturemaps-us-west-2.s3.amazonaws.com"
# 最新の版は、S3 の release/ の一覧から読みます。
RELEASE_LIST = BUCKET + "/?list-type=2&prefix=release/&delimiter=/&max-keys=100"
UA = ("tabisaki-kb/1.0 (https://github.com/shitianliang1000-alt/"
      "tabisaki.github.io; kb build)")

# 日本の範囲（南西諸島から北方領土まで含む）。
BBOX = (122.0, 20.0, 154.5, 46.5)     # xmin, ymin, xmax, ymax


def curl(url):
    r = subprocess.run(["curl", "-s", "-m", "60", "-A", UA, url],
                       capture_output=True, text=True)
    return r.stdout


def latest_release():
    """最新の版の名前。**「.0」と「.1」があれば、新しいほう**を採ります。"""
    names = re.findall(r"<Prefix>release/([^<]+)/</Prefix>", curl(RELEASE_LIST))
    if not names:
        raise SystemExit("Overture の版の一覧が取れませんでした。")
    return sorted(names)[-1]


def places_files(release):
    prefix = f"release/{release}/theme=places/type=place/"
    keys, token = [], None
    while True:
        url = (f"{BUCKET}/?list-type=2&prefix={urllib.parse.quote(prefix, safe='')}"
               f"&max-keys=1000")
        if token:
            url += "&continuation-token=" + urllib.parse.quote(token, safe="")
        t = curl(url)
        keys += re.findall(r"<Contents><Key>([^<]+)</Key>", t)
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", t)
        if not m:
            break
        token = m.group(1)
    return keys


def connect():
    import duckdb
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    # この環境は、プロキシの証明書を通します（無効にはしません）。
    ca = "/root/.ccr/ca-bundle.crt"
    if os.path.exists(ca):
        con.execute(f"SET ca_cert_file='{ca}';")
    proxy = os.environ.get("HTTPS_PROXY", "")
    if proxy:
        con.execute("SET http_proxy='%s';" % proxy.split("://")[-1].rstrip("/"))
    return con


def fetch():
    release = latest_release()
    keys = places_files(release)
    if not keys:
        raise SystemExit(f"{release} の places のファイルが見つかりません。")
    print(f"版 {release} / places {len(keys)}ファイル")
    os.makedirs(OUT, exist_ok=True)
    dst = os.path.join(OUT, "japan-places.parquet")
    tmp = dst + ".part"
    con = connect()
    x0, y0, x1, y1 = BBOX
    urls = ", ".join(f"'{BUCKET}/{k}'" for k in keys)
    # ファイルごとに日本の範囲を数え、あるものだけを読みます（位置順なので、
    # 日本のデータは1つのファイルに集まっています）。
    have = []
    for k in keys:
        n = con.execute(
            f"SELECT count(*) FROM read_parquet('{BUCKET}/{k}') "
            f"WHERE bbox.xmin >= {x0} AND bbox.xmax <= {x1} "
            f"AND bbox.ymin >= {y0} AND bbox.ymax <= {y1}").fetchone()[0]
        if n:
            print(f"  {k.rsplit('/', 1)[-1][:24]}…  日本 {n:,}件")
            have.append(k)
    if not have:
        raise SystemExit("日本の範囲に、データがありません。")
    src = ", ".join(f"'{BUCKET}/{k}'" for k in have)
    con.execute(f"""
        COPY (
          SELECT id,
                 names.primary                        AS name,
                 names.common['ja']                   AS name_ja,
                 -- 点なので、bbox の左下がそのまま座標です。ST_Y / ST_X は空間拡張
                 -- （spatial）が要るので、使いません（依存を増やさないため）。
                 bbox.ymin                            AS lat,
                 bbox.xmin                            AS lng,
                 confidence,
                 operating_status,
                 taxonomy.primary                     AS category,
                 taxonomy.hierarchy                   AS hierarchy,
                 addresses[1].region                  AS region,
                 addresses[1].locality                AS locality,
                 addresses[1].freeform                AS address,
                 sources[1].dataset                   AS dataset,
                 sources[1].license                   AS license
          FROM read_parquet([{src}])
          WHERE bbox.xmin >= {x0} AND bbox.xmax <= {x1}
            AND bbox.ymin >= {y0} AND bbox.ymax <= {y1}
            AND names.primary IS NOT NULL
        ) TO '{tmp}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)
    # 途中で切れたものを残しません（半分のファイルを、次に「もうある」と
    # 読まないため）。
    os.replace(tmp, dst)
    with open(os.path.join(OUT, "RELEASE"), "w", encoding="utf-8") as f:
        f.write(release + "\n")
    print(f"保存しました: {dst}")


def stats():
    import duckdb
    dst = os.path.join(OUT, "japan-places.parquet")
    if not os.path.exists(dst):
        raise SystemExit("まだ保存していません。python3 tools/fetch_overture_places.py")
    con = duckdb.connect()
    n = con.execute(f"SELECT count(*) FROM read_parquet('{dst}')").fetchone()[0]
    print(f"日本の施設 {n:,}件")
    for col in ("operating_status", "dataset", "license", "region"):
        print(f"\n{col}:")
        for v, c in con.execute(
                f"SELECT {col}, count(*) c FROM read_parquet('{dst}') "
                f"GROUP BY 1 ORDER BY c DESC LIMIT 8").fetchall():
            print(f"  {v}: {c:,}")


if __name__ == "__main__":
    if "--stats" in sys.argv:
        stats()
    else:
        fetch()
