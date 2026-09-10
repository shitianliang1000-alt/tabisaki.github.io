# -*- coding: utf-8 -*-
"""Wikidata から、日本の行き先の素データを落とす。

出力は data/wikidata/wd-<QID>.json（分類ごとに1ファイル）です。
取り込みは tools/import_wikidata.py がします。ここは取ってくるだけです。

**日本語版ウィキペディアに記事があるものだけ**を取ります。理由は
import_wikidata.py の冒頭に書いてあります。

問い合わせ先の Wikidata Query Service には1分の制限があります。ラベル
サービス（wikibase:label）や GROUP BY を混ぜると、その場で 504 が返って
きます。そこで

    ・ラベルは rdfs:label を直に見る（サービスを使わない）
    ・1回 1,500件ずつ、OFFSET をずらして取る
    ・落ちたら間を空けて数回やり直す

という形にしてあります。全部で30分ほどかかります。

    python3 tools/fetch_wikidata.py            収録に使う分類をぜんぶ
    python3 tools/fetch_wikidata.py Q845945    1つだけ
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
OUT = os.path.join(WEB, "data", "wikidata")

ENDPOINT = "https://query.wikidata.org/sparql"
UA = ("tabisaki-kb/1.0 (https://github.com/shitianliang1000-alt/"
      "tabisaki.github.io; kb build)")

QUERY = """SELECT ?x ?n ?lat ?lng WHERE {
  ?x wdt:P31/wdt:P279* wd:%s ;
     wdt:P17 wd:Q17 ;
     p:P625 ?st .
  ?st psv:P625 ?v .
  ?v wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lng .
  ?x rdfs:label ?n . FILTER(lang(?n)="ja")
  ?a schema:about ?x ; schema:isPartOf <https://ja.wikipedia.org/> .
} ORDER BY ?x LIMIT %d OFFSET %d"""

PAGE = 1500
CAP = 30000


def ask(query, tries=4):
    for i in range(tries):
        p = subprocess.run(
            ["curl", "-s", "-m", "600",
             "-H", "Accept: application/sparql-results+json",
             "-H", "User-Agent: " + UA,
             "--data-urlencode", "query=" + query, ENDPOINT],
            capture_output=True, text=True)
        try:
            return json.loads(p.stdout)["results"]["bindings"]
        except Exception:
            sys.stderr.write(f"  やり直し {i + 1}回目: {p.stdout[:100]}\n")
            time.sleep(10 * (i + 1))
    return None


def fetch(qid):
    rows, offset = [], 0
    while offset < CAP:
        got = ask(QUERY % (qid, PAGE, offset))
        if got is None:
            sys.stderr.write(f"  {qid}: {offset}件目でやめました\n")
            break
        rows += got
        if len(got) < PAGE:
            break
        offset += PAGE
    return [{"q": r["x"]["value"].rsplit("/", 1)[-1],
             "name": r["n"]["value"],
             "lat": float(r["lat"]["value"]),
             "lng": float(r["lng"]["value"])} for r in rows]


def main(qids):
    os.makedirs(OUT, exist_ok=True)
    for qid in qids:
        path = os.path.join(OUT, f"wd-{qid}.json")
        if os.path.exists(path) and os.path.getsize(path) > 2:
            print(f"{qid} はもうあります")
            continue
        rows = fetch(qid)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False)
        print(f"{qid} {len(rows)}件")


if __name__ == "__main__":
    from import_wikidata import CLASSES
    main(sys.argv[1:] or list(CLASSES))
