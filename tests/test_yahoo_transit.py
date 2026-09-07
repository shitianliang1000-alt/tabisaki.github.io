#!/usr/bin/env python3
import os
import sys
import unittest

# Ensure tools directory is in Python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "tools")))

from yahoo_transit import StationResolver, parse_yahoo_transit_html, haversine_km


class TestYahooTransit(unittest.TestCase):

    def setUp(self):
        self.resolver = StationResolver()

    def test_haversine_distance(self):
        dist = haversine_km(35.6812, 139.7671, 35.6751, 139.7633)
        self.assertGreater(dist, 0.5)
        self.assertLess(dist, 1.2)

    def test_station_resolver_coordinates(self):
        tokyo_coords = (35.681236, 139.767125)
        station = self.resolver.resolve(tokyo_coords)
        self.assertEqual(station, "東京")

    def test_station_resolver_dict_and_string(self):
        tokyo_dict = {"lat": 35.681236, "lng": 139.767125}
        self.assertEqual(self.resolver.resolve(tokyo_dict), "東京")
        self.assertEqual(self.resolver.resolve("35.681236, 139.767125"), "東京")
        self.assertEqual(self.resolver.resolve("新宿駅"), "新宿駅")

    def test_parse_yahoo_transit_html_success(self):
        html_content = """
        <html>
        <body>
            <div id="route01">
                <div class="time">10:00発→10:30着（30分）</div>
                <div class="small">乗換：1回 料金：500円</div>
                <dl class="station">
                    <dt><a href="#">東京</a></dt>
                </dl>
                <div class="transport">JR東海道本線（25分）</div>
                <dl class="station">
                    <dt><a href="#">横浜</a></dt>
                </dl>
            </div>
        </body>
        </html>
        """
        parsed = parse_yahoo_transit_html(html_content, fallback_from="東京", fallback_to="横浜")
        self.assertEqual(parsed["status"], "success")
        self.assertEqual(parsed["departure"], "東京")
        self.assertEqual(parsed["arrival"], "横浜")
        self.assertEqual(parsed["duration_minutes"], 30)
        self.assertEqual(parsed["board_at"], "東京")
        self.assertEqual(parsed["alight_at"], "横浜")
        self.assertIn("10:00発", parsed["time"])
        self.assertIn("乗換：1回", parsed["summary"])
        self.assertEqual(len(parsed["segments"]), 1)
        self.assertEqual(parsed["segments"][0]["kind"], "ride")
        self.assertEqual(parsed["segments"][0]["from"], "東京")
        self.assertEqual(parsed["segments"][0]["to"], "横浜")

    def test_parse_yahoo_transit_html_not_found(self):
        html_content = "<html><body><div>No route found</div></body></html>"
        parsed = parse_yahoo_transit_html(html_content)
        self.assertEqual(parsed["status"], "not_found")
        self.assertIn("経路データが見つかりませんでした", parsed["error"])

    def test_cli_json_output(self):
        import subprocess
        import json
        cmd = [sys.executable, "tools/yahoo_transit.py", "--from", "東京", "--to", "横浜", "--json"]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        self.assertEqual(proc.returncode, 0)
        output = proc.stdout.strip()
        data = json.loads(output)
        self.assertIn("status", data)


if __name__ == "__main__":
    unittest.main()
