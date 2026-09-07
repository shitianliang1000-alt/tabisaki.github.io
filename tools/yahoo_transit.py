#!/usr/bin/env python3
"""
Yahoo Transit search module with automatic nearest station lookup.
"""

import json
import math
import os
import sys
import urllib.parse
import requests
from bs4 import BeautifulSoup


def haversine_km(lat1, lon1, lat2, lon2):
    """Calculate the great-circle distance between two points in km."""
    r = 6371.0  # Earth radius in km
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2.0) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2.0) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


class StationResolver:
    """Loads stops database and resolves locations/coordinates to nearest station names."""

    def __init__(self, base_dir=None):
        if base_dir is None:
            base_dir = os.path.join(os.path.dirname(__file__), "..", "kb")
        self.base_dir = os.path.abspath(base_dir)
        self.stops = []
        self._load_stops()

    def _load_stops(self):
        rail_file = os.path.join(self.base_dir, "stops-rail.json")
        bus_file = os.path.join(self.base_dir, "stops-bus.json")

        for fpath, kind in [(rail_file, "rail"), (bus_file, "bus")]:
            if os.path.exists(fpath):
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        stops_list = data.get("stops", [])
                        for s in stops_list:
                            # s is [lat, lng, name]
                            self.stops.append(
                                {"lat": s[0], "lng": s[1], "name": s[2], "kind": kind}
                            )
                except Exception as e:
                    print(f"Warning: Failed to load {fpath}: {e}", file=sys.stderr)

    def find_nearest_station(self, lat, lng, max_km=10.0, kind_priority="rail"):
        """Find the nearest station to given lat/lng."""
        best = None
        best_km = float("inf")

        for s in self.stops:
            km = haversine_km(lat, lng, s["lat"], s["lng"])
            if km < best_km:
                # Prefer rail if distance difference is minimal (< 0.5km)
                if (
                    best
                    and abs(km - best_km) < 0.5
                    and s["kind"] == "rail"
                    and best["kind"] != "rail"
                ):
                    best = s
                    best_km = km
                elif km < best_km:
                    best = s
                    best_km = km

        if best and best_km <= max_km:
            return best
        return None

    def resolve(self, input_val):
        """
        Resolves input_val to a station name string.
        input_val can be:
        - string station name (e.g., '東京', '新宿駅')
        - dict with {'lat': float, 'lng': float} or {'lat': float, 'lon': float}
        - tuple/list (lat, lng)
        """
        if isinstance(input_val, (tuple, list)) and len(input_val) >= 2:
            lat, lng = float(input_val[0]), float(input_val[1])
            station = self.find_nearest_station(lat, lng)
            if station:
                return station["name"]
            return None

        if isinstance(input_val, dict):
            lat = input_val.get("lat") or input_val.get("latitude")
            lng = input_val.get("lng") or input_val.get("lon") or input_val.get("longitude")
            if lat is not None and lng is not None:
                station = self.find_nearest_station(float(lat), float(lng))
                if station:
                    return station["name"]
            if "name" in input_val:
                return self.resolve(input_val["name"])
            return None

        if isinstance(input_val, str):
            val = input_val.strip()
            if not val:
                return ""
            # If string contains lat,lng separated by comma (e.g. "35.6812,139.7671")
            if "," in val:
                parts = val.split(",")
                if len(parts) == 2:
                    try:
                        lat, lng = float(parts[0].strip()), float(parts[1].strip())
                        station = self.find_nearest_station(lat, lng)
                        if station:
                            return station["name"]
                    except ValueError:
                        pass
            return val

        return str(input_val)


def parse_yahoo_transit_html(html_text, fallback_from="", fallback_to=""):
    """Parses Yahoo Transit HTML and extracts route information."""
    soup = BeautifulSoup(html_text, "html.parser")
    route1 = soup.select_one("#route01") or soup.select_one(".elmRouteDetail")

    if not route1:
        return {
            "status": "not_found",
            "error": "経路データが見つかりませんでした。駅名が正しく入力されているか確認してください。",
        }

    time_elm = route1.select_one(".time")
    summary_elm = route1.select_one(".small")

    station_elms = route1.select(".station dt a") or route1.select(".station dt")
    departure = station_elms[0].text.strip() if station_elms else fallback_from
    arrival = station_elms[-1].text.strip() if station_elms else fallback_to

    time_str = time_elm.text.strip() if time_elm else ""
    summary_str = " ".join(summary_elm.text.split()) if summary_elm else ""

    return {
        "status": "success",
        "departure": departure,
        "arrival": arrival,
        "time": time_str,
        "summary": summary_str,
    }


def search_yahoo_transit(
    from_loc, to_loc, resolver=None, shin=1, ex=1, al=1, sort_mode=0
):
    """
    Automatically resolves locations to station names and performs Yahoo Transit search.

    :param from_loc: Station name, lat/lng dict/tuple, or location string.
    :param to_loc: Station name, lat/lng dict/tuple, or location string.
    :param resolver: StationResolver instance (optional).
    :param shin: Include Shinkansen (1=yes, 0=no).
    :param ex: Include Express trains (1=yes, 0=no).
    :param al: Include Airlines (1=yes, 0=no).
    :param sort_mode: Sort order (0=fastest, 1=cheapest, 2=fewest transfers).
    :return: dict with search results.
    """
    if resolver is None:
        resolver = StationResolver()

    from_station = resolver.resolve(from_loc) or str(from_loc)
    to_station = resolver.resolve(to_loc) or str(to_loc)

    if not from_station or not to_station:
        return {
            "status": "error",
            "error": "出発地または目的地を駅名に変換できませんでした。",
        }

    from_enc = urllib.parse.quote(from_station)
    to_enc = urllib.parse.quote(to_station)

    url = (
        f"https://transit.yahoo.co.jp/search/result"
        f"?from={from_enc}&to={to_enc}"
        f"&shin={shin}&ex={ex}&al={al}&s={sort_mode}"
    )

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
    }

    try:
        response = requests.get(url, headers=headers, timeout=10)
        if response.status_code == 200:
            result = parse_yahoo_transit_html(
                response.text, fallback_from=from_station, fallback_to=to_station
            )
            result["url"] = url
            result["from_input"] = from_station
            result["to_input"] = to_station
            return result
        else:
            return {
                "status": "error",
                "error": f"通信エラーが発生しました。HTTP Status: {response.status_code}",
                "url": url,
            }
    except Exception as e:
        return {
            "status": "error",
            "error": f"リクエスト中にエラーが発生しました: {e}",
            "url": url,
        }


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Yahoo Transit Route Search with Auto Station Resolution"
    )
    parser.add_argument(
        "--from",
        dest="from_loc",
        help="Departure station, spot, or lat,lng (e.g. '35.6812,139.7671' or '東京駅')",
    )
    parser.add_argument(
        "--to",
        dest="to_loc",
        help="Destination station, spot, or lat,lng (e.g. '横浜駅')",
    )

    args = parser.parse_args()

    resolver = StationResolver()

    from_loc = args.from_loc
    to_loc = args.to_loc

    if not from_loc:
        from_loc = input("出発地を入力してください (駅名 / スポット / 緯度,経度): ").strip()
    if not to_loc:
        to_loc = input("目的地を入力してください (駅名 / スポット / 緯度,経度): ").strip()

    from_resolved = resolver.resolve(from_loc)
    to_resolved = resolver.resolve(to_loc)

    print(f"\n[自動検出結果]")
    print(f" 出発地: '{from_loc}' -> 最寄り駅/指定: '{from_resolved}'")
    print(f" 目的地: '{to_loc}' -> 最寄り駅/指定: '{to_resolved}'")
    print("\n検索中...")

    res = search_yahoo_transit(from_loc, to_loc, resolver=resolver)

    if res["status"] == "success":
        print("\n--- 検索結果 ---")
        print(f"【出発】 {res['departure']}")
        print(f"【到着】 {res['arrival']}")
        if res.get("time"):
            print(f"【時間】 {res['time']}")
        if res.get("summary"):
            print(f"【概要】 {res['summary']}")
        print(f"【URL】 {res['url']}")
    else:
        print(f"\n検索失敗: {res.get('error')}")


if __name__ == "__main__":
    main()
