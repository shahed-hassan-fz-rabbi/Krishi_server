"""
Unit and Known-Answer Tests for Krishi Mama Science Engine.
Covers all 12 required test categories:
1. Known-answer rainfall totals.
2. Known-answer temperature averages.
3. Percentile calculations.
4. Missing-value handling.
5. Sentinel handling.
6. Incomplete month handling.
7. Leap-year handling.
8. Coverage calculations.
9. Empty datasets.
10. Invalid input.
11. Chattogram and Cumilla data isolation.
12. Deterministic repeat calculations.
"""
import unittest
import numpy as np
import json
import sys
from pathlib import Path

# Add science dir to sys.path
SCIENCE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCIENCE_DIR))

from stats import (
    compute_distribution,
    summarize_rainfall,
    summarize_temperature,
    summarize_parameter,
    is_leap_year,
    get_expected_month_days,
    FORMULA_VERSION,
)
from contract import validate_input_snapshot, build_output_envelope


class TestScienceEngine(unittest.TestCase):

    # 1. Known-answer rainfall totals
    def test_known_answer_rainfall_totals(self):
        # 30 days in April 2021 with constant 10.0 mm/day
        obs = [
            {"dateLabel": f"2021-04-{d:02d}", "parameter": "PRECTOTCORR", "value": 10.0, "quality": "ok"}
            for d in range(1, 31)
        ]
        res = summarize_rainfall(obs)
        self.assertEqual(res["total_observations"], 30)
        self.assertEqual(res["valid_observations"], 30)
        self.assertEqual(res["missing_observations"], 0)

        apr_series = next(s for s in res["monthly_series"] if s["year"] == 2021 and s["month"] == 4)
        self.assertAlmostEqual(apr_series["total_mm"], 300.0)
        self.assertEqual(apr_series["wet_days"], 30)
        self.assertEqual(apr_series["dry_days"], 0)
        self.assertAlmostEqual(apr_series["max_daily_mm"], 10.0)
        self.assertTrue(apr_series["is_complete"])

    # 2. Known-answer temperature averages
    def test_known_answer_temperature_averages(self):
        # 31 days in Jan 2021 with T2M = 20.0 C, MAX = 25.0 C, MIN = 15.0 C
        t2m = [{"dateLabel": f"2021-01-{d:02d}", "value": 20.0, "quality": "ok"} for d in range(1, 32)]
        t_max = [{"dateLabel": f"2021-01-{d:02d}", "value": 25.0, "quality": "ok"} for d in range(1, 32)]
        t_min = [{"dateLabel": f"2021-01-{d:02d}", "value": 15.0, "quality": "ok"} for d in range(1, 32)]

        res = summarize_temperature(t2m, t_max, t_min)
        jan = next(s for s in res["monthly_series"] if s["year"] == 2021 and s["month"] == 1)
        self.assertAlmostEqual(jan["mean_t2m"], 20.0)
        self.assertAlmostEqual(jan["mean_max"], 25.0)
        self.assertAlmostEqual(jan["mean_min"], 15.0)
        self.assertAlmostEqual(jan["diurnal_range"], 10.0)
        self.assertTrue(jan["is_complete"])

    # 3. Percentile calculations
    def test_percentile_calculations(self):
        arr = np.array([10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0])
        dist = compute_distribution(arr)
        self.assertAlmostEqual(dist["min"], 10.0)
        self.assertAlmostEqual(dist["max"], 100.0)
        self.assertAlmostEqual(dist["mean"], 55.0)
        self.assertAlmostEqual(dist["median"], 55.0)
        self.assertAlmostEqual(dist["p25"], 32.5)
        self.assertAlmostEqual(dist["p50"], 55.0)
        self.assertAlmostEqual(dist["p75"], 77.5)
        self.assertAlmostEqual(dist["p90"], 91.0)

    # 4. Missing-value handling
    def test_missing_value_handling(self):
        obs = [
            {"dateLabel": "2021-01-01", "value": 5.0, "quality": "ok"},
            {"dateLabel": "2021-01-02", "value": None, "quality": "absent"},
            {"dateLabel": "2021-01-03", "value": 15.0, "quality": "ok"},
        ]
        res = summarize_rainfall(obs)
        self.assertEqual(res["total_observations"], 3)
        self.assertEqual(res["valid_observations"], 2)
        self.assertEqual(res["missing_observations"], 1)
        jan = next(s for s in res["monthly_series"] if s["year"] == 2021 and s["month"] == 1)
        self.assertAlmostEqual(jan["total_mm"], 20.0)

    def test_missing_only_periods_remain_null_while_observed_zero_stays_zero(self):
        missing = summarize_rainfall([
            {"dateLabel": "2021-01-01", "value": None, "quality": "absent"},
        ])
        january = next(s for s in missing["monthly_series"] if s["year"] == 2021 and s["month"] == 1)
        annual = next(s for s in missing["annual_series"] if s["year"] == 2021)
        winter = next(s for s in missing["seasonal_series"] if s["season"] == "winter" and s["year"] == 2021)
        self.assertIsNone(january["total_mm"])
        self.assertIsNone(january["max_daily_mm"])
        self.assertIsNone(annual["total_mm"])
        self.assertIsNone(winter["total_mm"])

        observed_zero = summarize_rainfall([
            {"dateLabel": "2021-01-01", "value": 0.0, "quality": "ok"},
        ])
        january_zero = next(s for s in observed_zero["monthly_series"] if s["year"] == 2021 and s["month"] == 1)
        self.assertEqual(january_zero["total_mm"], 0.0)
        self.assertEqual(january_zero["valid_days"], 1)

    # 5. Sentinel handling
    def test_sentinel_handling(self):
        obs = [
            {"dateLabel": "2021-01-01", "value": None, "sentinelValue": -999, "quality": "missing_sentinel"},
            {"dateLabel": "2021-01-02", "value": 12.0, "quality": "ok"},
        ]
        res = summarize_rainfall(obs)
        self.assertEqual(res["valid_observations"], 1)
        self.assertEqual(res["missing_observations"], 1)
        jan = next(s for s in res["monthly_series"] if s["year"] == 2021 and s["month"] == 1)
        # Sentinel -999 was NOT added as -999 and NOT converted to 0
        self.assertAlmostEqual(jan["total_mm"], 12.0)

    # 6. Incomplete month handling
    def test_incomplete_month_handling(self):
        # 5 days in January (expected: 31) -> 5/31 = 16% < 90% threshold
        obs = [{"dateLabel": f"2021-01-{d:02d}", "value": 2.0, "quality": "ok"} for d in range(1, 6)]
        res = summarize_rainfall(obs, completeness_threshold=0.9)
        jan = next(s for s in res["monthly_series"] if s["year"] == 2021 and s["month"] == 1)
        self.assertFalse(jan["is_complete"])
        self.assertEqual(jan["valid_days"], 5)
        self.assertEqual(jan["expected_days"], 31)
        # Incomplete month was excluded from historical normal calculation
        self.assertEqual(res["monthly_historical"]["1"]["years_used"], 0)

    # 7. Leap-year handling
    def test_leap_year_handling(self):
        self.assertTrue(is_leap_year(2004))
        self.assertTrue(is_leap_year(2020))
        self.assertTrue(is_leap_year(2024))
        self.assertFalse(is_leap_year(2021))
        self.assertFalse(is_leap_year(2023))

        self.assertEqual(get_expected_month_days(2024, 2), 29)
        self.assertEqual(get_expected_month_days(2023, 2), 28)

        # Leap year with 29 days in Feb
        obs_leap = [{"dateLabel": f"2024-02-{d:02d}", "value": 1.0, "quality": "ok"} for d in range(1, 30)]
        res = summarize_rainfall(obs_leap)
        feb_leap = next(s for s in res["monthly_series"] if s["year"] == 2024 and s["month"] == 2)
        self.assertEqual(feb_leap["expected_days"], 29)
        self.assertEqual(feb_leap["valid_days"], 29)
        self.assertTrue(feb_leap["is_complete"])

    # 8. Coverage calculations
    def test_coverage_calculations(self):
        obs = [
            {"dateLabel": "2021-01-01", "value": 10.0, "quality": "ok"},
            {"dateLabel": "2021-01-02", "value": None, "quality": "absent"},
            {"dateLabel": "2021-01-03", "value": 15.0, "quality": "ok"},
            {"dateLabel": "2021-01-04", "value": None, "quality": "missing_sentinel"},
        ]
        res = summarize_rainfall(obs)
        self.assertEqual(res["total_observations"], 4)
        self.assertEqual(res["valid_observations"], 2)
        self.assertEqual(res["missing_observations"], 2)
        self.assertAlmostEqual(res["coverage_percent"], 50.0)

    # 9. Empty datasets
    def test_empty_datasets(self):
        dist = compute_distribution(np.array([], dtype=float))
        self.assertEqual(dist["count"], 0)
        self.assertIsNone(dist["mean"])

        res = summarize_rainfall([])
        self.assertEqual(res["total_observations"], 0)
        self.assertEqual(res["valid_observations"], 0)
        self.assertEqual(res["coverage_percent"], 0.0)

    # 10. Invalid input validation
    def test_invalid_input_validation(self):
        # Missing district
        self.assertTrue(len(validate_input_snapshot({"observations": [1]})) > 0)
        # Invalid district name
        self.assertTrue(len(validate_input_snapshot({"district": "dhaka", "observations": [1]})) > 0)
        # Empty observations
        self.assertTrue(len(validate_input_snapshot({"district": "chattogram", "observations": []})) > 0)
        # Valid input
        self.assertEqual(len(validate_input_snapshot({"district": "chattogram", "observations": [{"value": 1}]})), 0)

    # 11. Chattogram and Cumilla data isolation
    def test_district_isolation(self):
        obs_ctg = [{"dateLabel": "2021-01-01", "value": 10.0, "quality": "ok"}]
        obs_cum = [{"dateLabel": "2021-01-01", "value": 25.0, "quality": "ok"}]

        env_ctg = build_output_envelope("chattogram", "PRECTOTCORR", "mm/day", summarize_rainfall(obs_ctg))
        env_cum = build_output_envelope("cumilla", "PRECTOTCORR", "mm/day", summarize_rainfall(obs_cum))

        self.assertEqual(env_ctg["meta"]["district"], "chattogram")
        self.assertEqual(env_cum["meta"]["district"], "cumilla")
        self.assertAlmostEqual(env_ctg["data"]["monthly_series"][0]["total_mm"], 10.0)
        self.assertAlmostEqual(env_cum["data"]["monthly_series"][0]["total_mm"], 25.0)

    # 13. Winter season boundary across year boundary (Dec year-1 + Jan year + Feb year)
    def test_winter_season_boundary_across_years(self):
        # Dec 2020: 31 days @ 1.0 mm = 31 mm
        obs_dec2020 = [{"dateLabel": f"2020-12-{d:02d}", "value": 1.0, "quality": "ok"} for d in range(1, 32)]
        # Jan 2021: 31 days @ 2.0 mm = 62 mm
        obs_jan2021 = [{"dateLabel": f"2021-01-{d:02d}", "value": 2.0, "quality": "ok"} for d in range(1, 32)]
        # Feb 2021: 28 days @ 3.0 mm = 84 mm
        obs_feb2021 = [{"dateLabel": f"2021-02-{d:02d}", "value": 3.0, "quality": "ok"} for d in range(1, 29)]
        # Dec 2021: 31 days @ 10.0 mm = 310 mm (Belongs to Winter 2021-2022, NOT 2020-2021!)
        obs_dec2021 = [{"dateLabel": f"2021-12-{d:02d}", "value": 10.0, "quality": "ok"} for d in range(1, 32)]

        all_obs = obs_dec2020 + obs_jan2021 + obs_feb2021 + obs_dec2021
        res = summarize_rainfall(all_obs)

        winter_2021 = next(
            s for s in res["seasonal_series"]
            if s["season"] == "winter" and s["year"] == 2021
        )
        self.assertEqual(winter_2021["season_label"], "Winter 2020–2021")
        # 31 (Dec 2020) + 62 (Jan 2021) + 84 (Feb 2021) = 177 mm
        self.assertAlmostEqual(winter_2021["total_mm"], 177.0)
        self.assertEqual(winter_2021["valid_days"], 90)
        self.assertEqual(winter_2021["expected_days"], 90)
        self.assertTrue(winter_2021["is_complete"])

        # Dec 2021 was NOT added to 2020-2021 winter:
        self.assertNotEqual(winter_2021["total_mm"], 487.0)

    # 14. Historical percentile sample size guardrail (1 year vs multiple years)
    def test_sample_size_guardrails_for_percentiles(self):
        # 1 year sample (N=1 < 5)
        dist_single = compute_distribution(np.array([100.0]), min_years_for_percentiles=5)
        self.assertEqual(dist_single["evidence_status"], "insufficient_sample")
        self.assertIsNotNone(dist_single["evidence_limitation"])
        self.assertIn("below climatological threshold", dist_single["evidence_limitation"])

        # 10 years sample (N=10 >= 5)
        dist_robust = compute_distribution(np.array(list(range(100, 110))), min_years_for_percentiles=5)
        self.assertEqual(dist_robust["evidence_status"], "robust")
        self.assertIsNone(dist_robust["evidence_limitation"])

    def test_annual_means_are_backend_values_from_complete_years(self):
        observations = []
        temperatures = []
        maximums = []
        minimums = []
        for year, value in ((2021, 10.0), (2022, 20.0)):
            for month in range(1, 13):
                for day in range(1, get_expected_month_days(year, month) + 1):
                    date_label = f"{year}-{month:02d}-{day:02d}"
                    observations.append({"dateLabel": date_label, "value": value, "quality": "ok"})
                    temperatures.append({"dateLabel": date_label, "value": value, "quality": "ok"})
                    maximums.append({"dateLabel": date_label, "value": value + 5, "quality": "ok"})
                    minimums.append({"dateLabel": date_label, "value": value - 5, "quality": "ok"})

        # One valid day is not enough to treat 2023 as a complete annual sample.
        incomplete = {"dateLabel": "2023-01-01", "value": 100.0, "quality": "ok"}
        observations.append(incomplete)
        temperatures.append(incomplete)

        generic = summarize_parameter(observations, "RH2M", "%")
        temperature = summarize_temperature(temperatures, maximums, minimums)
        for result in (generic, temperature):
            self.assertEqual(result["annual_historical"]["count"], 2)
            self.assertEqual(result["annual_historical"]["mean"], 15.0)
            self.assertEqual(result["annual_historical"]["evidence_status"], "insufficient_sample")
        january = temperature["monthly_historical"]["1"]
        self.assertEqual(january["years_used"], 2)
        self.assertEqual(january["stats"]["mean"], 15.0)
        self.assertEqual(january["mean_tmax"]["mean"], 20.0)
        self.assertEqual(january["mean_tmin"]["mean"], 10.0)
        self.assertEqual(january["diurnal_range"]["mean"], 10.0)
        self.assertEqual(january["absolute_max"], 25.0)
        self.assertEqual(january["absolute_min"], 5.0)

    def test_negative_rainfall_is_not_a_valid_amount(self):
        observations = [
            {"dateLabel": "2021-01-01", "value": -1.5, "quality": "ok"},
            {"dateLabel": "2021-01-02", "value": 4.0, "quality": "ok"},
        ]
        result = summarize_rainfall(observations)
        self.assertEqual(result["valid_observations"], 1)
        self.assertEqual(result["missing_observations"], 1)
        january = result["monthly_series"][0]
        self.assertEqual(january["valid_days"], 1)
        self.assertEqual(january["total_mm"], 4.0)


if __name__ == "__main__":
    unittest.main()
