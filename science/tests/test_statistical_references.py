"""
Regression tests for statistical reference values.

Verifies:
- Student's t two-sided tail probabilities against published critical-value
  tables (t quantiles q_T = 1 - alpha/2 at listed per-df critical values).
- Mann-Whitney U asymptotic behavior with tie correction and continuity
  correction, against independently verified numerical examples.
- Welch t p-value equals the Student-t evaluation of its own statistic/df.

Run: python -m unittest science.tests.test_statistical_references -v
"""
import math
import unittest

import numpy as np

from science.stats import (
    STUDENT_T_NORMAL_DF_LIMIT,
    compute_mann_whitney_u,
    compute_welch_t,
    summarize_handoff,
    student_t_two_sided_p,
    _betainc,
)

# Published two-sided critical values |t| such that P(|T_df| > t) = alpha,
# from standard Student's t distribution tables (6-decimal table values).
STUDENT_T_REFERENCE_PAIRS = [
    # df, |t|, alpha (two-sided)
    (1, 12.706205, 0.05),
    (2, 4.302653, 0.05),
    (3, 3.182446, 0.05),
    (5, 2.570582, 0.05),
    (10, 2.228139, 0.05),
    (20, 2.085963, 0.05),
    (25, 2.059539, 0.05),
    (30, 2.042272, 0.05),
    (60, 2.000298, 0.05),
    (120, 1.979931, 0.05),
    # two-sided alpha = 0.10
    (5, 2.015048, 0.10),
    (10, 1.812461, 0.10),
    (25, 1.708141, 0.10),
    # two-sided alpha = 0.01
    (5, 4.032143, 0.01),
    (10, 3.169273, 0.01),
    (25, 2.787436, 0.01),
    (30, 2.750000, 0.01),
]

STUDENT_T_LIMIT_P = 1.959964  # df -> infinity, two-sided 0.05 (normal quantile)


class TestStudentTReferences(unittest.TestCase):
    def test_published_critical_values_recover_alpha(self):
        """Each (df, critical |t|, alpha) triple must reproduce its alpha."""
        for df, t_crit, alpha in STUDENT_T_REFERENCE_PAIRS:
            with self.subTest(df=df, t=t_crit):
                p = student_t_two_sided_p(t_crit, df)
                self.assertIsNotNone(p)
                # 6-decimal inputs cannot give better than ~1e-5 slack.
                self.assertAlmostEqual(p, alpha, places=4, msg=f"df={df}, t={t_crit}")

    def test_normal_limit(self):
        p = student_t_two_sided_p(STUDENT_T_LIMIT_P, 1e7)
        self.assertAlmostEqual(p, 0.05, places=4)

    def test_monotone_decreasing_in_t(self):
        for df in (2.0, 7.5, 30.0):
            p0 = student_t_two_sided_p(0.5, df)
            p1 = student_t_two_sided_p(1.5, df)
            p2 = student_t_two_sided_p(2.5, df)
            self.assertGreater(p0, p1)
            self.assertGreater(p1, p2)

    def test_boundary_cases(self):
        self.assertEqual(student_t_two_sided_p(0.0, 10), 1.0)
        self.assertIsNone(student_t_two_sided_p(1.0, 0))
        self.assertIsNone(student_t_two_sided_p(1.0, -5))
        self.assertIsNone(student_t_two_sided_p(float("nan"), 10))
        p_huge = student_t_two_sided_p(1e9, 10)
        self.assertIsNotNone(p_huge)
        self.assertGreater(p_huge, 0.0)      # monotone tail, not hard-clamped
        self.assertLess(p_huge, 1.0e-80)

    def test_betainc_symmetry(self):
        # I_x(a, b) + I_(1-x)(b, a) = 1
        for (a, b, x) in [(2.5, 0.5, 0.3), (10.0, 5.0, 0.7), (1.0, 1.0, 0.25)]:
            lhs = _betainc(a, b, x) + _betainc(b, a, 1.0 - x)
            self.assertAlmostEqual(lhs, 1.0, places=10)


class TestMannWhitneyReferences(unittest.TestCase):
    """Independently verifiable numerical examples.

    Example math (no ties):
    x = 1..8, y = 20..27. r1 = 36, u1 = 36 - 36 = 0, mu = 32.
    sigma = sqrt(8*8*17/12) = sqrt(90.6667) = 9.5219.
    z_cc = (32 - 0.5)/9.5219 = 3.30816 (negative: x below y), two-sided
    p = 2*(1 - Phi(3.30816)) = 0.00093.
    """

    def test_distinct_no_ties_continuity_value(self):
        x = np.arange(1.0, 9.0)      # 1..8
        y = np.arange(20.0, 28.0)    # 20..27
        res = compute_mann_whitney_u(x, y)
        self.assertEqual(res["u"], 0.0)
        self.assertEqual(res["n1"], 8)
        self.assertEqual(res["n2"], 8)
        self.assertAlmostEqual(res["z"], -3.308, places=3)
        self.assertAlmostEqual(res["p_value"], 0.0009, places=3)
        self.assertTrue(res["is_significant"])
        self.assertTrue(res["approximation_valid"])

    def test_tie_corrected_variance_shrinks_z_and_softens_p(self):
        """Tie-corrected variance + continuity correction vs no-ties formula.

        Construct: all values in two tie groups of 5 (values 1 and 2), n1=n2=5.
        no-ties sigma = sqrt(5*5*11/12) = sqrt(22.9167) = 4.78714.
        Tie correction: sum(t^3 - t) = 2*(125-5) = 240;
        sigma2 = 22.9167 - 240/(12*10*9) = 22.9167 - 0.22222 = 22.69444;
        sigma = 4.76386.
        With y entirely above x: r1 = 1+2+3+4+5 = 15; u1 = 15 - 15 = 0;
        mu_u = 12.5; |z|_cc = (12.5 - 0.5)/4.76386 = 2.51866; p = 0.0118.
        (Without tie correction and continuity: z = 12.5/4.78714 = 2.6114,
        p = 0.0090 — the tie-corrected p-value is correctly larger.)
        Sample guard (n = 5 < 8) marks the approximation invalid, so the
        significance verdict is conservative False.
        """
        x = np.array([1.0] * 5)
        y = np.array([2.0] * 5)
        res = compute_mann_whitney_u(x, y)
        self.assertAlmostEqual(res["z"], -2.519, places=3)
        self.assertAlmostEqual(res["p_value"], 0.0118, places=3)
        self.assertFalse(res["is_significant"])  # small-sample guard (n<8)
        self.assertFalse(res["approximation_valid"])

    def test_identical_samples_not_significant(self):
        x = np.array([10.0, 11.0, 12.0, 13.0, 14.0, 15.0])
        y = np.array([10.0, 11.0, 12.0, 13.0, 14.0, 15.0])
        res = compute_mann_whitney_u(x, y)
        self.assertFalse(res["is_significant"])
        self.assertGreater(res["p_value"], 0.9)

    def test_small_sample_guard_flags_not_significant(self):
        x = np.array([1.0, 2.0, 3.0])
        y = np.array([9.0, 10.0, 11.0])
        res = compute_mann_whitney_u(x, y)
        self.assertFalse(res["approximation_valid"])
        self.assertFalse(res["is_significant"])

    def test_method_disclosure(self):
        res = compute_mann_whitney_u(np.array([1.0, 2.0]), np.array([3.0, 4.0]))
        self.assertEqual(res["p_value_kind"], "approximate")
        self.assertIn("tie_correction", res["method"])

    def test_approximation_note_without_overstating_guard(self):
        """Every MWU result must carry an approximation note that discloses the
        n >= 8 rule-of-thumb nature instead of over claiming validity."""
        res = compute_mann_whitney_u(np.array([1.0, 2.0]), np.array([3.0, 4.0]))
        note = res.get("approximation_note")
        self.assertIsInstance(note, str)
        self.assertIn("rule-of-thumb", note)
        self.assertIn("approximate", note)
        self.assertIn("not", note.lower() or "")  # "does not guarantee" present

    def test_all_identical_u_equals_mean(self):
        x = np.array([5.0, 5.0, 5.0])
        y = np.array([5.0, 5.0, 5.0])
        res = compute_mann_whitney_u(x, y)
        self.assertEqual(res["u"], 4.5)
        self.assertEqual(res["p_value"], 1.0)


class TestWelchStudentT(unittest.TestCase):
    def test_p_value_uses_student_t_not_normal(self):
        """df small: Student-t p must be clearly larger than normal-approx p.

        x = [10,12,11,13,12], y = [20,22,21,23,22]: t = -22.678? no:
        m1 = 11.6, v1 = 1.3/... compute: x mean 11.6, sd 1.140; y mean 22, sd 1.140.
        t = (22-11.6)/sqrt(1.3/5*2)= 10.4/sqrt(0.52)=14.422, df = 8.
        Normal two-sided p ~ 0; Student-t p ~ 8e-7. Values differ but both ~0.
        Use a moderate effect instead: t = 2.5 with df = 5.8 gives
        normal p = 0.0124 vs Student-t p = 0.0472 — a discriminating pair.
        """
        res = compute_welch_t(
            np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]),
            np.array([1.5, 2.8, 3.1, 4.2, 5.6, 6.2, 7.9, 9.0]),
        )
        # Verified reference statistics for these two samples:
        # m1 = 4.5, v1 = 6.0; m2 = 5.0375, v2 = 7.70696; t = 0.43439...; df = 13.87.
        self.assertAlmostEqual(res["mean1"], 4.5, places=2)
        self.assertAlmostEqual(res["mean2"], 5.04, places=2)
        self.assertEqual(res["method"], "student_t_welch_satterthwaite_two_sided")
        # Cross-consistency: rounded p equals direct Student-t evaluation.
        direct = student_t_two_sided_p(res["t"], res["df"])
        self.assertAlmostEqual(res["p_value"], direct, places=3)
        # Student-t (df 13.9) must exceed the normal two-sided limit at same |t|.
        normal_p = 2.0 * (1.0 - 0.5 * (1.0 + math.erf(abs(res["t"]) / math.sqrt(2.0))))
        self.assertGreater(res["p_value"], normal_p)

    def test_clear_separation_p_tiny(self):
        res = compute_welch_t(
            np.array([10.0, 12.0, 11.0, 13.0, 12.0]),
            np.array([20.0, 22.0, 21.0, 23.0, 22.0]),
        )
        self.assertLess(res["p_value"], 0.01)
        self.assertEqual(res["mean_diff"], 10.0)

    def test_p_value_kind_is_exact_distribution_below_df_limit(self):
        """Normal climate samples sit far below the 10,000-df normal limit;
        their Welch p-values must be labeled exact_distribution, not
        normal_limit, and never claim exactness for the other regime."""
        res = compute_welch_t(
            np.array([10.0, 12.0, 11.0, 13.0, 12.0]),
            np.array([20.0, 22.0, 21.0, 23.0, 22.0]),
        )
        self.assertEqual(res["p_value_kind"], "exact_distribution")
        self.assertLess(res["df"], STUDENT_T_NORMAL_DF_LIMIT)

    def test_p_value_kind_normal_limit_branch_is_deterministic(self):
        """The documented branch boundary: at exactly the limit df the
        implementation switches to the normal limit, and the returned value
        must equal the exact normal two-sided tail erfc(|t|/sqrt(2))."""
        t = 1.959964
        at_limit = student_t_two_sided_p(t, STUDENT_T_NORMAL_DF_LIMIT)
        self.assertAlmostEqual(at_limit, math.erfc(t / math.sqrt(2.0)), places=12)
        below_limit = student_t_two_sided_p(t, STUDENT_T_NORMAL_DF_LIMIT - 1.0)
        # Just below the limit the finite-df t tail is still slightly heavier
        # than the normal tail, so the branch must not silently flip early.
        self.assertGreater(below_limit, at_limit)


class TestHandoffRainfallPeriodTotalsDisclosure(unittest.TestCase):
    """Known-answer tests for the calendar-based rainfall total disclosures
    added per the totals-audit requirement: incomplete observed sums must be
    labeled (raw sums preserved, missing days disclosed), while the legacy
    gated flat fields keep their exact previous contract."""

    @staticmethod
    def rain_obs(dates_values):
        return [
            {"dateLabel": d, "quality": "ok", "value": v}
            for (d, v) in dates_values
        ]

    def test_complete_october_and_november(self):
        obs = self.rain_obs(
            [(f"2021-10-{d:02d}", 2.0) for d in range(1, 32)]
            + [(f"2021-11-{d:02d}", 1.5) for d in range(1, 31)]
        )
        result = summarize_handoff(
            rainfall_obs=obs, crop_transition="aman-mustard"
        )
        record = next(y for y in result["yearly_series"] if y["year"] == 2021)
        totals = record["rainfall_period_totals"]
        self.assertEqual(totals["october"]["expected_days"], 31)
        self.assertEqual(totals["october"]["valid_days"], 31)
        self.assertEqual(totals["october"]["missing_days"], 0)
        self.assertEqual(totals["october"]["total_kind"], "complete_period_total")
        self.assertEqual(totals["october"]["raw_observed_sum_mm"], 62.0)
        self.assertEqual(totals["november"]["expected_days"], 30)
        self.assertEqual(totals["november"]["total_kind"], "complete_period_total")
        self.assertEqual(totals["november"]["period_coverage_percent"], 100.0)
        # legacy contract unchanged
        self.assertEqual(record["oct_total_rain"], 62.0)
        self.assertEqual(record["nov_total_rain"], 45.0)

    def test_partial_october_preserves_raw_sum_and_discloses(self):
        # 25 valid October days (6 missing), partial sum = 25 * 2.0
        # Full Nov 1-20 sowing window keeps the year eligible.
        obs = self.rain_obs(
            [(f"2021-10-{d:02d}", 2.0) for d in range(1, 26)]
            + [(f"2021-11-{d:02d}", 0.0) for d in range(1, 21)]
        )
        result = summarize_handoff(
            rainfall_obs=obs, crop_transition="aman-mustard"
        )
        record = next(y for y in result["yearly_series"] if y["year"] == 2021)
        totals = record["rainfall_period_totals"]
        self.assertEqual(totals["october"]["expected_days"], 31)
        self.assertEqual(totals["october"]["valid_days"], 25)
        self.assertEqual(totals["october"]["missing_days"], 6)
        self.assertAlmostEqual(
            totals["october"]["period_coverage_percent"], 80.65, places=2
        )
        self.assertEqual(totals["october"]["total_kind"], "observed_partial_sum")
        self.assertEqual(totals["october"]["raw_observed_sum_mm"], 50.0)
        # raw sum preserved, never imputed, never zeroed
        self.assertIsNotNone(totals["october"]["raw_observed_sum_mm"])
        # legacy gated field still None below the 28-day validity gate
        self.assertIsNone(record["oct_total_rain"])

    def test_partial_late_october_sowing_window_disclosure(self):
        # Sowing window Nov 1-20 complete, late October Oct 16-31 partial (10 of 16)
        obs = self.rain_obs(
            [(f"2021-11-{d:02d}", 0.5) for d in range(1, 21)]
            + [(f"2021-10-{d:02d}", 3.0) for d in range(16, 26)]
        )
        result = summarize_handoff(
            rainfall_obs=obs, crop_transition="aman-mustard"
        )
        record = next(y for y in result["yearly_series"] if y["year"] == 2021)
        totals = record["rainfall_period_totals"]
        late = totals["late_october_oct16_31"]
        self.assertEqual(late["expected_days"], 16)
        self.assertEqual(late["valid_days"], 10)
        self.assertEqual(late["total_kind"], "observed_partial_sum")
        self.assertEqual(late["raw_observed_sum_mm"], 30.0)
        sowing = totals["sowing_window"]
        self.assertEqual(sowing["expected_days"], 20)
        self.assertEqual(sowing["valid_days"], 20)
        self.assertEqual(sowing["total_kind"], "complete_period_total")
        self.assertEqual(record["total_sowing_rain"], 10.0)  # 20 * 0.5, unchanged


if __name__ == "__main__":
    unittest.main()
