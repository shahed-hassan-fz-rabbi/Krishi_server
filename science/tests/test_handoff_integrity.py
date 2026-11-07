"""Isolated Handoff integrity checks.

These tests lock the scientific contract. They do not change production code.
Against the current engine, the held-behavior tests should pass and the defect
tests should fail:

Held:
- a missing sowing-window date breaks a dry run
- non-ok and sentinel values are not dry days and lower sowing-window coverage
- workable_window_frequency_pct uses the historical year denominator
- probability and unsupported agronomic category fields stay out of the result

Defects still expected against the current CLI envelope:
- a calendar day with no stored row is omitted from the coverage denominator
- a duplicate valid row inflates valid_observations
- NaN and infinity are counted as valid observations
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

SCIENCE_DIR = Path(__file__).resolve().parent.parent
RUN_PY = SCIENCE_DIR / "run.py"
sys.path.insert(0, str(SCIENCE_DIR))

from stats import summarize_handoff


FORBIDDEN_LABELS = ("optimal", "moderate_delay", "constrained")


def rain_day(year, day, value, quality="ok"):
    return {
        "dateLabel": f"{year:04d}-11-{day:02d}",
        "value": value,
        "quality": quality,
    }


def november_window(year, values_by_day):
    """Build Nov 1-20 rows. Omitted days are absent. values_by_day maps day -> (value, quality)."""
    rows = []
    for day, spec in sorted(values_by_day.items()):
        value, quality = spec
        rows.append(rain_day(year, day, value, quality))
    return rows


def broken_dry_spell(year, gap_value, gap_quality):
    """Nov 1-4 dry, day 5 supplied by the caller, day 6 dry, Nov 7-20 wet."""
    values = {day: (0.0, "ok") for day in (1, 2, 3, 4, 6)}
    values[5] = (gap_value, gap_quality)
    for day in range(7, 21):
        values[day] = (2.0, "ok")
    return november_window(year, values)


def find_forbidden_labels(value, path="$"):
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            key_text = str(key)
            for label in FORBIDDEN_LABELS:
                if label in key_text:
                    found.append(f"{path}.{key_text}")
                    break
            found.extend(find_forbidden_labels(item, f"{path}.{key_text}"))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(find_forbidden_labels(item, f"{path}[{index}]"))
    elif isinstance(value, str):
        for label in FORBIDDEN_LABELS:
            if label in value:
                found.append(f"{path}={value}")
                break
    return found


class TestHandoffIntegrityHeld(unittest.TestCase):
    def test_missing_date_breaks_consecutive_dry_run(self):
        rows = november_window(
            2020,
            {
                **{day: (0.0, "ok") for day in (1, 2, 3, 4, 6)},
                **{day: (2.0, "ok") for day in range(7, 21)},
            },
        )
        result = summarize_handoff(rainfall_obs=rows, crop_transition="aman-mustard")
        year = result["yearly_series"][0]

        self.assertEqual(year["max_dry_run"], 4)
        self.assertFalse(year["workable_window"])
        self.assertEqual(year["dry_days_sowing"], 5)
        self.assertEqual(year["valid_days_sowing"], 19)
        self.assertEqual(year["missing_days_sowing"], 1)
        self.assertIn("2020-11-05", year["missing_dates_sowing"])

    def test_non_ok_observation_is_not_a_dry_day_and_lowers_coverage(self):
        rows = broken_dry_spell(2020, gap_value=0.0, gap_quality="missing")
        result = summarize_handoff(rainfall_obs=rows, crop_transition="aman-mustard")
        year = result["yearly_series"][0]

        self.assertEqual(year["max_dry_run"], 4)
        self.assertEqual(year["dry_days_sowing"], 5)
        self.assertEqual(year["valid_days_sowing"], 19)
        self.assertEqual(year["missing_days_sowing"], 1)
        self.assertEqual(year["coverage_pct_sowing"], 95.0)
        self.assertIn("2020-11-05", year["missing_dates_sowing"])

    def test_sentinel_observation_is_not_a_dry_day_and_lowers_coverage(self):
        rows = broken_dry_spell(2020, gap_value=-999.0, gap_quality="ok")
        result = summarize_handoff(rainfall_obs=rows, crop_transition="aman-mustard")
        year = result["yearly_series"][0]

        self.assertEqual(year["max_dry_run"], 4)
        self.assertEqual(year["dry_days_sowing"], 5)
        self.assertEqual(year["valid_days_sowing"], 19)
        self.assertEqual(year["coverage_pct_sowing"], 95.0)
        self.assertIn("2020-11-05", year["missing_dates_sowing"])

    def test_complete_sowing_window_reports_full_valid_day_coverage(self):
        rows = [rain_day(2020, day, 0.0) for day in range(1, 21)]
        result = summarize_handoff(rainfall_obs=rows, crop_transition="aman-mustard")
        year = result["yearly_series"][0]

        self.assertEqual(year["expected_days_sowing"], 20)
        self.assertEqual(year["valid_days_sowing"], 20)
        self.assertEqual(year["missing_days_sowing"], 0)
        self.assertEqual(year["coverage_pct_sowing"], 100.0)

    def test_frequency_uses_historical_year_denominator(self):
        workable = [rain_day(2020, day, 0.0) for day in range(1, 21)]
        not_workable = [rain_day(2021, day, 2.0) for day in range(1, 21)]
        result = summarize_handoff(
            rainfall_obs=workable + not_workable,
            crop_transition="aman-mustard",
        )
        opportunity = result["sowing_opportunity"]

        self.assertEqual(result["years_used"], 2)
        self.assertEqual(opportunity["total_years"], 2)
        self.assertEqual(opportunity["years_with_workable_window"], 1)
        self.assertEqual(opportunity["workable_window_frequency_pct"], 50.0)
        self.assertEqual(
            opportunity["workable_window_frequency_pct"],
            round((1 / 2) * 100, 1),
        )


def cli_rainfall(year, day, value, quality="ok"):
    return {
        "parameter": "PRECTOTCORR",
        "dateLabel": f"{year:04d}-11-{day:02d}",
        "value": value,
        "quality": quality,
    }


def run_handoff_envelope(observations):
    completed = subprocess.run(
        [
            sys.executable,
            str(RUN_PY),
            "handoff",
            "--district",
            "cumilla",
            "--crop-transition",
            "aman-mustard",
            "--input",
            "-",
        ],
        input=json.dumps({"district": "cumilla", "observations": observations}),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    return completed


def envelope_coverage(meta):
    return (
        meta["coverage_percent"],
        meta["valid_observations"],
        meta["missing_observations"],
    )


class TestHandoffIntegrityDefects(unittest.TestCase):
    def test_cli_coverage_envelope_uses_valid_sowing_observations(self):
        observations = []
        for day in range(1, 20):
            observations.append({
                "parameter": "PRECTOTCORR",
                "dateLabel": f"2020-11-{day:02d}",
                "value": 0.0,
                "quality": "ok",
            })
        observations.append({
            "parameter": "PRECTOTCORR",
            "dateLabel": "2020-11-20",
            "value": -999.0,
            "quality": "missing",
        })
        payload = {"district": "cumilla", "observations": observations}
        completed = subprocess.run(
            [
                sys.executable,
                str(RUN_PY),
                "handoff",
                "--district",
                "cumilla",
                "--crop-transition",
                "aman-mustard",
                "--input",
                "-",
            ],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        envelope = json.loads(completed.stdout)
        meta = envelope["meta"]

        self.assertEqual(
            (
                meta["coverage_percent"],
                meta["valid_observations"],
                meta["missing_observations"],
            ),
            (95.0, 19, 1),
            "Handoff CLI meta must use valid sowing-window observations, not a hardcoded 100 percent",
        )

    def test_absent_calendar_date_counts_in_coverage_denominator(self):
        observations = [cli_rainfall(2020, day, 0.0) for day in range(1, 20)]
        completed = run_handoff_envelope(observations)

        self.assertEqual(completed.returncode, 0, completed.stderr)
        meta = json.loads(completed.stdout)["meta"]
        self.assertNotIn("2020-11-20", [row["dateLabel"] for row in observations])
        self.assertEqual(
            envelope_coverage(meta),
            (95.0, 19, 1),
            "A Nov 20 with no stored row must be one missing day out of 20 expected days",
        )

    def test_duplicate_valid_row_does_not_inflate_coverage(self):
        observations = [cli_rainfall(2020, day, 0.0) for day in range(1, 21)]
        observations.append(cli_rainfall(2020, 1, 0.0))
        completed = run_handoff_envelope(observations)

        self.assertEqual(completed.returncode, 0, completed.stderr)
        meta = json.loads(completed.stdout)["meta"]
        self.assertEqual(len(observations), 21)
        self.assertEqual(
            envelope_coverage(meta),
            (100.0, 20, 0),
            "One duplicated valid day must not raise valid_observations above the 20-day window",
        )

    def test_non_finite_values_are_not_valid_observations(self):
        observations = [cli_rainfall(2020, day, 0.0) for day in range(1, 18)]
        observations.extend([
            cli_rainfall(2020, 18, float("nan")),
            cli_rainfall(2020, 19, float("inf")),
            cli_rainfall(2020, 20, float("-inf")),
        ])
        completed = run_handoff_envelope(observations)

        self.assertEqual(completed.returncode, 0, completed.stderr)
        meta = json.loads(completed.stdout)["meta"]
        self.assertEqual(
            envelope_coverage(meta),
            (85.0, 17, 3),
            "NaN and infinity must be missing, not valid, in a 20-day window",
        )

    def test_workable_window_probability_field_is_absent(self):
        rows = [rain_day(2020, day, 0.0) for day in range(1, 21)]
        result = summarize_handoff(rainfall_obs=rows, crop_transition="aman-mustard")
        serialized = json.dumps(result)

        self.assertNotIn("workable_window_probability_pct", result["sowing_opportunity"])
        self.assertNotIn("workable_window_probability_pct", serialized)
        self.assertIn("workable_window_frequency_pct", result["sowing_opportunity"])

    def test_unsupported_agronomic_categories_are_absent(self):
        rows = [rain_day(2020, day, 0.0) for day in range(1, 21)]
        result = summarize_handoff(rainfall_obs=rows, crop_transition="aman-mustard")
        found = find_forbidden_labels(result)

        self.assertEqual(
            found,
            [],
            "Unsupported categories remain in the Handoff result: " + ", ".join(found),
        )

    def test_negative_rainfall_is_invalid_and_breaks_dry_run(self):
        rows = broken_dry_spell(2020, gap_value=-1.5, gap_quality="ok")
        result = summarize_handoff(rainfall_obs=rows, crop_transition="aman-mustard")
        year = result["yearly_series"][0]
        self.assertEqual(year["max_dry_run"], 4)
        self.assertEqual(year["valid_days_sowing"], 19)
        self.assertIn("2020-11-05", year["missing_dates_sowing"])

        completed = run_handoff_envelope([
            cli_rainfall(2020, day, -1.5 if day == 5 else 0.0) for day in range(1, 21)
        ])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(envelope_coverage(json.loads(completed.stdout)["meta"]), (95.0, 19, 1))

    def test_negative_temperature_remains_valid(self):
        rain = [rain_day(2020, day, 0.0) for day in range(1, 21)]
        tmin = [rain_day(2020, day, -2.5) for day in range(1, 21)]
        for row in tmin:
            row["parameter"] = "T2M_MIN"
        result = summarize_handoff(
            rainfall_obs=rain,
            t2m_min_obs=tmin,
            crop_transition="aman-mustard",
        )
        self.assertEqual(result["yearly_series"][0]["mean_tmin_sowing"], -2.5)
        self.assertEqual(result["duplicate_conflicts"], [])

    def test_conflicting_duplicates_are_excluded_independent_of_order(self):
        def rows(first, second):
            return [rain_day(2020, 1, first), rain_day(2020, 1, second)] + [
                rain_day(2020, day, 2.0) for day in range(2, 21)
            ]

        forward = summarize_handoff(rainfall_obs=rows(0.0, 5.0), crop_transition="aman-mustard")
        reverse = summarize_handoff(rainfall_obs=rows(5.0, 0.0), crop_transition="aman-mustard")
        self.assertEqual(forward["yearly_series"], reverse["yearly_series"])
        self.assertEqual(forward["duplicate_conflicts"], reverse["duplicate_conflicts"])
        self.assertEqual(forward["yearly_series"][0]["valid_days_sowing"], 19)
        self.assertEqual(forward["yearly_series"][0]["max_dry_run"], 0)
        self.assertIn("2020-11-01", forward["yearly_series"][0]["missing_dates_sowing"])
        conflict = forward["duplicate_conflicts"][0]
        self.assertEqual(conflict["dateLabel"], "2020-11-01")
        self.assertEqual(conflict["resolution"], "excluded_unresolved_conflict")
        self.assertEqual(conflict["distinct_values"], [0.0, 5.0])
        self.assertIn("not averaged", forward["duplicate_policy"])
        self.assertIn("not selected by input order", forward["duplicate_policy"])

    def test_low_coverage_year_is_excluded_and_disclosed(self):
        rows = [cli_rainfall(2020, day, 0.0) for day in range(1, 10)]
        result = summarize_handoff(rainfall_obs=rows, crop_transition="aman-mustard")
        self.assertEqual(result["years_used"], 0)
        self.assertEqual(result["yearly_series"], [])
        self.assertEqual(len(result["excluded_years"]), 1)
        excluded = result["excluded_years"][0]
        self.assertEqual(excluded["year"], 2020)
        self.assertEqual(excluded["expected_days_sowing"], 20)
        self.assertEqual(excluded["valid_days_sowing"], 9)
        self.assertEqual(excluded["missing_days_sowing"], 11)
        self.assertEqual(excluded["coverage_pct_sowing"], 45.0)
        self.assertFalse(excluded["included_in_yearly_series"])
        self.assertNotIn("workable_window", excluded)
        self.assertEqual(
            result["yearly_eligibility"]["denominator"],
            "expected_sowing_window_calendar_days",
        )

        completed = run_handoff_envelope(rows)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        envelope = json.loads(completed.stdout)
        self.assertEqual(envelope_coverage(envelope["meta"]), (45.0, 9, 11))
        self.assertEqual(envelope["data"]["excluded_years"][0]["year"], 2020)


if __name__ == "__main__":
    unittest.main()
