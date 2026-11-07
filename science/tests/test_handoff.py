import unittest
import numpy as np
import sys
from pathlib import Path

# Add science dir to sys.path
SCIENCE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCIENCE_DIR))

from stats import (
    compute_mann_whitney_u,
    compute_welch_t,
    summarize_handoff,
    CROP_TRANSITIONS,
)


class TestHandoffStatistics(unittest.TestCase):
    def test_crop_transitions_config(self):
        self.assertIn("aman-mustard", CROP_TRANSITIONS)
        cfg = CROP_TRANSITIONS["aman-mustard"]
        self.assertEqual(cfg["sowing_month"], 11)
        self.assertEqual(cfg["sowing_days_start"], 1)
        self.assertEqual(cfg["sowing_days_end"], 20)
        self.assertEqual(cfg["min_consecutive_dry_days"], 5)

    def test_mann_whitney_u_identical(self):
        # Two identical distributions should yield non-significant p-value ~ 1.0
        x = np.array([10.0, 11.0, 12.0, 13.0, 14.0, 15.0])
        y = np.array([10.0, 11.0, 12.0, 13.0, 14.0, 15.0])
        res = compute_mann_whitney_u(x, y)
        self.assertEqual(res["n1"], 6)
        self.assertEqual(res["n2"], 6)
        self.assertEqual(res["u"], 18.0)
        self.assertFalse(res["is_significant"])
        self.assertGreater(res["p_value"], 0.9)

    def test_mann_whitney_u_distinct(self):
        # Two clearly separated distributions should yield p < 0.05
        x = np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0])
        y = np.array([20.0, 21.0, 22.0, 23.0, 24.0, 25.0, 26.0, 27.0])
        res = compute_mann_whitney_u(x, y)
        self.assertTrue(res["is_significant"])
        self.assertLess(res["p_value"], 0.01)

    def test_welch_t_computation(self):
        x = np.array([10.0, 12.0, 11.0, 13.0, 12.0])
        y = np.array([20.0, 22.0, 21.0, 23.0, 22.0])
        res = compute_welch_t(x, y)
        self.assertAlmostEqual(res["mean_diff"], 10.0, places=1)
        self.assertLess(res["p_approx"], 0.01)

    def test_summarize_handoff_fixture(self):
        # Generate 2 years of daily data (2020 and 2021)
        rainfall_obs = []
        t2m_min_obs = []

        for year in [2020, 2021]:
            for month in range(10, 12):  # Oct and Nov
                days = 31 if month == 10 else 30
                for day in range(1, days + 1):
                    date_lbl = f"{year:04d}-{month:02d}-{day:02d}"
                    # In Nov 1-20, let's make most days dry (< 1.0mm)
                    if month == 11 and day <= 20:
                        rain_val = 0.0 if day % 5 != 0 else 2.5
                        tmin_val = 18.5
                    else:
                        rain_val = 1.5
                        tmin_val = 20.0

                    rainfall_obs.append({
                        "dateLabel": date_lbl,
                        "value": rain_val,
                        "quality": "ok",
                    })
                    t2m_min_obs.append({
                        "dateLabel": date_lbl,
                        "value": tmin_val,
                        "quality": "ok",
                    })

        res = summarize_handoff(
            rainfall_obs=rainfall_obs,
            t2m_min_obs=t2m_min_obs,
            crop_transition="aman-mustard",
            period1_years=(2020, 2020),
            period2_years=(2021, 2021),
        )

        self.assertEqual(res["transition_id"], "aman-mustard")
        self.assertEqual(res["years_used"], 2)
        self.assertIn("sowing_opportunity", res)
        self.assertIn("period_comparison", res)
        self.assertIn("yearly_series", res)
        self.assertEqual(len(res["yearly_series"]), 2)

        # In Nov 1-20, 4 days (5, 10, 15, 20) are wet (2.5mm), 16 days are dry (0.0mm)
        yr0 = res["yearly_series"][0]
        self.assertEqual(yr0["dry_days_sowing"], 16)
        self.assertEqual(yr0["wet_days_sowing"], 4)
        self.assertEqual(yr0["max_dry_run"], 4)

    def test_consecutive_dry_run_scenarios(self):
        # Scenario 1: Five consecutive valid dry days (Nov 1-5 dry, Nov 6-20 wet)
        obs_s1 = [{"dateLabel": f"2020-11-{d:02d}", "value": 0.0 if d <= 5 else 2.0, "quality": "ok"} for d in range(1, 21)]
        res1 = summarize_handoff(rainfall_obs=obs_s1, crop_transition="aman-mustard")
        yr1 = res1["yearly_series"][0]
        self.assertEqual(yr1["max_dry_run"], 5)
        self.assertTrue(yr1["workable_window"])
        self.assertEqual(yr1["expected_days_sowing"], 20)
        self.assertEqual(yr1["valid_days_sowing"], 20)
        self.assertEqual(yr1["missing_days_sowing"], 0)

        # Scenario 2: 4 dry days, 1 MISSING day (Nov 5 absent), then 1 dry day (Nov 6)
        # MUST NOT bridge! Expected max_dry_run = 4, NOT 5
        obs_s2 = []
        for d in range(1, 21):
            if d == 5:
                continue  # Day 5 is unobserved/missing
            val = 0.0 if d in [1, 2, 3, 4, 6] else 3.0
            obs_s2.append({"dateLabel": f"2020-11-{d:02d}", "value": val, "quality": "ok"})
        res2 = summarize_handoff(rainfall_obs=obs_s2, crop_transition="aman-mustard")
        yr2 = res2["yearly_series"][0]
        self.assertEqual(yr2["max_dry_run"], 4)  # STRICTLY 4: Day 5 reset the streak
        self.assertFalse(yr2["workable_window"])
        self.assertEqual(yr2["valid_days_sowing"], 19)
        self.assertEqual(yr2["missing_days_sowing"], 1)
        self.assertIn("2020-11-05", yr2["missing_dates_sowing"])

        # Scenario 3: Interrupted by rainfall >= 1.0 mm (Days 1-3 dry, Day 4 rain 1.5mm, Days 5-8 dry)
        obs_s3 = []
        for d in range(1, 21):
            if d in [1, 2, 3]:
                val = 0.2  # dry
            elif d == 4:
                val = 1.5  # rain >= 1.0mm interrupts
            elif d in [5, 6, 7, 8]:
                val = 0.1  # dry
            else:
                val = 4.0  # wet
            obs_s3.append({"dateLabel": f"2020-11-{d:02d}", "value": val, "quality": "ok"})
        res3 = summarize_handoff(rainfall_obs=obs_s3, crop_transition="aman-mustard")
        yr3 = res3["yearly_series"][0]
        self.assertEqual(yr3["max_dry_run"], 4)  # Run of 3, then reset, then run of 4

        # Scenario 4: Sentinel (-999, -999.0) and absent quality records reset sequence
        obs_s4 = []
        for d in range(1, 21):
            if d in [1, 2, 3, 4]:
                obs_s4.append({"dateLabel": f"2020-11-{d:02d}", "value": 0.0, "quality": "ok"})
            elif d == 5:
                obs_s4.append({"dateLabel": f"2020-11-{d:02d}", "value": -999.0, "quality": "missing"})
            elif d == 6:
                obs_s4.append({"dateLabel": f"2020-11-{d:02d}", "value": 0.0, "quality": "ok"})
            else:
                obs_s4.append({"dateLabel": f"2020-11-{d:02d}", "value": 2.0, "quality": "ok"})
        res4 = summarize_handoff(rainfall_obs=obs_s4, crop_transition="aman-mustard")
        yr4 = res4["yearly_series"][0]
        self.assertEqual(yr4["max_dry_run"], 4)  # Sentinel on day 5 interrupted the run
        self.assertIn("2020-11-05", yr4["missing_dates_sowing"])

        # Scenario 5: Duplicate dates must not duplicate day count or inflate dry runs
        obs_s5 = []
        # Add Nov 1 three times with 0.0mm
        obs_s5.append({"dateLabel": "2020-11-01", "value": 0.0, "quality": "ok"})
        obs_s5.append({"dateLabel": "2020-11-01", "value": 0.0, "quality": "ok"})
        obs_s5.append({"dateLabel": "2020-11-01", "value": 0.0, "quality": "ok"})
        for d in range(2, 21):
            obs_s5.append({"dateLabel": f"2020-11-{d:02d}", "value": 2.0, "quality": "ok"})
        res5 = summarize_handoff(rainfall_obs=obs_s5, crop_transition="aman-mustard")
        yr5 = res5["yearly_series"][0]
        self.assertEqual(yr5["dry_days_sowing"], 1)  # Exactly 1 dry day despite 3 entries
        self.assertEqual(yr5["max_dry_run"], 1)

        # Scenario 6: Incomplete observation window (<90% coverage) is excluded
        obs_s6 = [{"dateLabel": f"2020-11-{d:02d}", "value": 0.0, "quality": "ok"} for d in range(1, 10)]
        res6 = summarize_handoff(rainfall_obs=obs_s6, crop_transition="aman-mustard")
        self.assertEqual(res6["years_used"], 0)
        self.assertEqual(res6["evidence_status"], "insufficient_data")


if __name__ == "__main__":
    unittest.main()
