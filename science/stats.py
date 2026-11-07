"""
Krishi Mama — Deterministic Scientific Processing Engine
Formula Version: v1.0.0-phase3

Scientific rules:
- Deterministic calculations using NumPy.
- Missing values (sentinels, absent, null) are strictly excluded; never converted to 0.
- Percentiles calculated using NumPy's standard linear interpolation (Hyndman & Fan Type 7).
- Project-selected wet-day threshold: daily precipitation >= 1.0 mm.
- Wet/dry counts use only valid daily precipitation observations; this is not an agronomic threshold.
- BMD (Bangladesh Meteorological Department) standard meteorological seasons:
    - Winter: December to February (Dec–Feb)
    - Pre-Monsoon: March to May (Mar–May)
    - Monsoon: June to September (Jun–Sep)
    - Post-Monsoon: October to November (Oct–Nov)
"""
from typing import Any, Dict, List, Optional
import math
import numpy as np

FORMULA_VERSION = "v1.0.0-phase3"

SEASONS_DEFINITION = {
    "winter": {"months": [12, 1, 2], "name_en": "Winter", "name_bn": "শীতকাল"},
    "pre_monsoon": {"months": [3, 4, 5], "name_en": "Pre-Monsoon", "name_bn": "প্রাক-বর্ষা"},
    "monsoon": {"months": [6, 7, 8, 9], "name_en": "Monsoon", "name_bn": "বর্ষাকাল"},
    "post_monsoon": {"months": [10, 11], "name_en": "Post-Monsoon", "name_bn": "শরৎ-হেমন্ত"},
}

DAYS_PER_MONTH_NORMAL = {1: 31, 2: 28, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31}


def is_leap_year(year: int) -> bool:
    return (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0)


def get_expected_month_days(year: int, month: int) -> int:
    if month == 2 and is_leap_year(year):
        return 29
    return DAYS_PER_MONTH_NORMAL.get(month, 30)


def finite_observation_value(obs: Dict[str, Any]) -> Optional[float]:
    """Finite quality-ok value, excluding the NASA -999 sentinel.

    Non-finite values are rejected. Negative magnitudes stay available for
    parameters whose documented range includes them.
    """
    if obs.get("quality") != "ok":
        return None
    raw = obs.get("value")
    if raw is None or isinstance(raw, bool):
        return None
    try:
        number = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number == -999.0:
        return None
    return number


def compute_distribution(arr: np.ndarray, min_years_for_percentiles: int = 5) -> Dict[str, Any]:
    """
    Computes min, max, mean, median, P25, P50, P75, P90 using standard linear interpolation.
    Enforces scientific evidence guardrail: when sample size N < 5, flags evidence_status
    as 'insufficient_sample' with an explicit limitation disclosure.
    """
    valid = arr[~np.isnan(arr)]
    n = int(len(valid))
    if n == 0:
        return {
            "count": 0,
            "min": None,
            "max": None,
            "mean": None,
            "median": None,
            "p25": None,
            "p50": None,
            "p75": None,
            "p90": None,
            "evidence_status": "no_data",
            "evidence_limitation": "No valid historical observations available for this period.",
        }

    p25, p50, p75, p90 = np.percentile(valid, [25, 50, 75, 90], method="linear")
    is_insufficient = n < min_years_for_percentiles

    return {
        "count": n,
        "min": float(np.round(np.min(valid), 4)),
        "max": float(np.round(np.max(valid), 4)),
        "mean": float(np.round(np.mean(valid), 4)),
        "median": float(np.round(p50, 4)),
        "p25": float(np.round(p25, 4)),
        "p50": float(np.round(p50, 4)),
        "p75": float(np.round(p75, 4)),
        "p90": float(np.round(p90, 4)),
        "evidence_status": "insufficient_sample" if is_insufficient else "robust",
        "evidence_limitation": (
            f"Sample size (N={n} years) is below climatological threshold (N < {min_years_for_percentiles}). "
            "Percentiles are descriptive of the limited sample and should not be treated as a robust long-term baseline."
            if is_insufficient
            else None
        ),
    }


def summarize_rainfall(observations: List[Dict[str, Any]], completeness_threshold: float = 0.9) -> Dict[str, Any]:
    """
    Processes daily PRECTOTCORR observations into:
    - Monthly totals per year
    - Annual totals per year
    - Historical monthly normals & percentiles
    - Seasonal rainfall totals & distributions
    - Daily extremes and frequency metrics
    """
    by_year_month: Dict[int, Dict[int, List[float]]] = {}
    total_valid = 0
    total_missing = 0
    all_values: List[float] = []

    for obs in observations:
        date_str = obs.get("dateLabel") or obs.get("date", "")[:10]
        val = obs.get("value")
        quality = obs.get("quality")

        year = int(date_str[:4])
        month = int(date_str[5:7])

        if year not in by_year_month:
            by_year_month[year] = {m: [] for m in range(1, 13)}

        if quality == "ok" and val is not None and val >= 0:
            by_year_month[year][month].append(float(val))
            all_values.append(float(val))
            total_valid += 1
        else:
            total_missing += 1

    years_sorted = sorted(by_year_month.keys())
    monthly_series: List[Dict[str, Any]] = []
    annual_series: List[Dict[str, Any]] = []
    month_totals_history: Dict[int, List[float]] = {m: [] for m in range(1, 13)}

    for year in years_sorted:
        year_total = 0.0
        year_valid_days = 0
        year_expected_days = 366 if is_leap_year(year) else 365

        for month in range(1, 13):
            days = by_year_month[year][month]
            expected = get_expected_month_days(year, month)
            valid_count = len(days)
            is_complete = (valid_count / expected) >= completeness_threshold if expected > 0 else False

            month_total = float(np.sum(days)) if valid_count > 0 else None
            wet_days = sum(1 for d in days if d >= 1.0)
            max_daily = float(np.max(days)) if valid_count > 0 else None

            monthly_series.append({
                "year": year,
                "month": month,
                "total_mm": np.round(month_total, 2) if month_total is not None else None,
                "wet_days": wet_days,
                "dry_days": valid_count - wet_days,
                "max_daily_mm": np.round(max_daily, 2) if max_daily is not None else None,
                "valid_days": valid_count,
                "expected_days": expected,
                "is_complete": is_complete,
            })

            if is_complete and month_total is not None:
                month_totals_history[month].append(month_total)

            if month_total is not None:
                year_total += month_total
            year_valid_days += valid_count

        year_complete = (year_valid_days / year_expected_days) >= completeness_threshold
        annual_series.append({
            "year": year,
            "total_mm": np.round(year_total, 2) if year_valid_days > 0 else None,
            "valid_days": year_valid_days,
            "expected_days": year_expected_days,
            "is_complete": year_complete,
        })

    # Historical monthly summary (normals & percentiles across valid years)
    monthly_historical: Dict[str, Any] = {}
    for month in range(1, 13):
        totals = np.array(month_totals_history[month], dtype=float)
        dist = compute_distribution(totals)
        monthly_historical[str(month)] = {
            "month": month,
            "years_used": int(dist["count"]),
            "stats": dist,
        }

    # Seasonal Aggregation
    seasonal_series: List[Dict[str, Any]] = []
    season_history: Dict[str, List[float]] = {k: [] for k in SEASONS_DEFINITION}

    for year in years_sorted:
        for s_key, s_meta in SEASONS_DEFINITION.items():
            if s_key == "winter":
                # Winter is Dec (year-1) + Jan (year) + Feb (year).
                # Example: Dec 2020 + Jan 2021 + Feb 2021 = Winter 2020-2021 (ending year 2021).
                # December 2021 is NEVER grouped with Jan/Feb 2021.
                dec_days = by_year_month.get(year - 1, {}).get(12, [])
                jan_days = by_year_month.get(year, {}).get(1, [])
                feb_days = by_year_month.get(year, {}).get(2, [])

                s_valid_days = len(dec_days) + len(jan_days) + len(feb_days)
                feb_expected = 29 if is_leap_year(year) else 28
                s_expected_days = 31 + 31 + feb_expected
                s_total = (
                    float(np.sum(dec_days) + np.sum(jan_days) + np.sum(feb_days))
                    if s_valid_days > 0
                    else None
                )

                is_complete = (s_valid_days / s_expected_days) >= completeness_threshold
                seasonal_series.append({
                    "year": year,
                    "season": "winter",
                    "season_label": f"Winter {year-1}–{year}",
                    "span_description": f"Dec {year-1} + Jan {year} + Feb {year}",
                    "total_mm": np.round(s_total, 2) if s_total is not None else None,
                    "valid_days": s_valid_days,
                    "expected_days": s_expected_days,
                    "is_complete": is_complete,
                })
                if is_complete and s_total is not None:
                    season_history["winter"].append(s_total)
            else:
                s_total = 0.0
                s_valid_days = 0
                s_expected_days = 0

                for m in s_meta["months"]:
                    days = by_year_month[year][m]
                    s_total += float(np.sum(days))
                    s_valid_days += len(days)
                    s_expected_days += get_expected_month_days(year, m)

                is_complete = (s_valid_days / s_expected_days) >= completeness_threshold
                if s_valid_days == 0:
                    s_total = None
                seasonal_series.append({
                    "year": year,
                    "season": s_key,
                    "season_label": f"{s_meta['name_en']} {year}",
                    "span_description": f"Months {s_meta['months']} of {year}",
                    "total_mm": np.round(s_total, 2) if s_total is not None else None,
                    "valid_days": s_valid_days,
                    "expected_days": s_expected_days,
                    "is_complete": is_complete,
                })
                if is_complete and s_total is not None:
                    season_history[s_key].append(s_total)

    seasonal_historical: Dict[str, Any] = {}
    for s_key, totals_list in season_history.items():
        dist = compute_distribution(np.array(totals_list, dtype=float))
        seasonal_historical[s_key] = {
            "season": s_key,
            "name_en": SEASONS_DEFINITION[s_key]["name_en"],
            "name_bn": SEASONS_DEFINITION[s_key]["name_bn"],
            "months": SEASONS_DEFINITION[s_key]["months"],
            "years_used": int(dist["count"]),
            "stats": dist,
        }

    # Annual historical distribution
    valid_annual = np.array(
        [a["total_mm"] for a in annual_series if a["is_complete"] and a["total_mm"] is not None],
        dtype=float,
    )
    annual_dist = compute_distribution(valid_annual)

    total_count = total_valid + total_missing
    coverage_pct = round((total_valid / total_count * 100), 2) if total_count > 0 else 0.0

    return {
        "parameter": "PRECTOTCORR",
        "unit": "mm/day",
        "formula_version": FORMULA_VERSION,
        "years_used": len(years_sorted),
        "total_observations": total_count,
        "valid_observations": total_valid,
        "missing_observations": total_missing,
        "coverage_percent": coverage_pct,
        "annual_historical": annual_dist,
        "monthly_historical": monthly_historical,
        "seasonal_historical": seasonal_historical,
        "annual_series": annual_series,
        "monthly_series": monthly_series,
        "seasonal_series": seasonal_series,
    }


def summarize_temperature(
    t2m_obs: List[Dict[str, Any]],
    t2m_max_obs: Optional[List[Dict[str, Any]]] = None,
    t2m_min_obs: Optional[List[Dict[str, Any]]] = None,
    completeness_threshold: float = 0.9,
) -> Dict[str, Any]:
    """
    Summarizes temperature data:
    - Monthly mean T2M, mean T2M_MAX, mean T2M_MIN
    - Monthly absolute extreme max/min
    - Diurnal temperature range (DTR = T2M_MAX - T2M_MIN)
    - Historical monthly normals & percentiles (P25, P50, P75, P90)
    """
    by_date_t2m: Dict[str, float] = {}
    by_date_max: Dict[str, float] = {}
    by_date_min: Dict[str, float] = {}

    for o in t2m_obs:
        d = o.get("dateLabel") or o.get("date", "")[:10]
        if o.get("quality") == "ok" and o.get("value") is not None:
            by_date_t2m[d] = float(o["value"])

    if t2m_max_obs:
        for o in t2m_max_obs:
            d = o.get("dateLabel") or o.get("date", "")[:10]
            if o.get("quality") == "ok" and o.get("value") is not None:
                by_date_max[d] = float(o["value"])

    if t2m_min_obs:
        for o in t2m_min_obs:
            d = o.get("dateLabel") or o.get("date", "")[:10]
            if o.get("quality") == "ok" and o.get("value") is not None:
                by_date_min[d] = float(o["value"])

    # Group by year and month
    by_year_month: Dict[int, Dict[int, List[str]]] = {}
    for d in by_date_t2m.keys():
        year = int(d[:4])
        month = int(d[5:7])
        if year not in by_year_month:
            by_year_month[year] = {m: [] for m in range(1, 13)}
        by_year_month[year][month].append(d)

    years_sorted = sorted(by_year_month.keys())
    monthly_series: List[Dict[str, Any]] = []
    month_means_history: Dict[int, List[float]] = {m: [] for m in range(1, 13)}
    max_means_history: Dict[int, List[float]] = {m: [] for m in range(1, 13)}
    min_means_history: Dict[int, List[float]] = {m: [] for m in range(1, 13)}
    diurnal_history: Dict[int, List[float]] = {m: [] for m in range(1, 13)}
    absolute_max_by_month: Dict[int, List[float]] = {m: [] for m in range(1, 13)}
    absolute_min_by_month: Dict[int, List[float]] = {m: [] for m in range(1, 13)}

    for year in years_sorted:
        for month in range(1, 13):
            dates = by_year_month[year][month]
            expected = get_expected_month_days(year, month)
            valid_days = len(dates)
            is_complete = (valid_days / expected) >= completeness_threshold if expected > 0 else False

            t_vals = [by_date_t2m[d] for d in dates]
            max_vals = [by_date_max[d] for d in dates if d in by_date_max]
            min_vals = [by_date_min[d] for d in dates if d in by_date_min]

            mean_t = float(np.mean(t_vals)) if t_vals else None
            mean_max = float(np.mean(max_vals)) if max_vals else None
            abs_max = float(np.max(max_vals)) if max_vals else None
            mean_min = float(np.mean(min_vals)) if min_vals else None
            abs_min = float(np.min(min_vals)) if min_vals else None

            dtr = None
            if mean_max is not None and mean_min is not None:
                dtr = float(np.round(mean_max - mean_min, 2))

            record = {
                "year": year,
                "month": month,
                "mean_t2m": round(mean_t, 2) if mean_t is not None else None,
                "mean_max": round(mean_max, 2) if mean_max is not None else None,
                "abs_max": round(abs_max, 2) if abs_max is not None else None,
                "mean_min": round(mean_min, 2) if mean_min is not None else None,
                "abs_min": round(abs_min, 2) if abs_min is not None else None,
                "diurnal_range": dtr,
                "valid_days": valid_days,
                "expected_days": expected,
                "is_complete": is_complete,
            }
            monthly_series.append(record)
            if is_complete and mean_t is not None:
                month_means_history[month].append(mean_t)
            max_complete = expected > 0 and len(max_vals) / expected >= completeness_threshold
            min_complete = expected > 0 and len(min_vals) / expected >= completeness_threshold
            if max_complete and mean_max is not None:
                max_means_history[month].append(mean_max)
            if min_complete and mean_min is not None:
                min_means_history[month].append(mean_min)
            if max_complete and min_complete and mean_max is not None and mean_min is not None:
                diurnal_history[month].append(mean_max - mean_min)
            if abs_max is not None:
                absolute_max_by_month[month].append(abs_max)
            if abs_min is not None:
                absolute_min_by_month[month].append(abs_min)

    # Historical monthly temperature normals & percentiles
    monthly_historical: Dict[str, Any] = {}
    for month in range(1, 13):
        vals = np.array(month_means_history[month], dtype=float)
        dist = compute_distribution(vals)
        monthly_historical[str(month)] = {
            "month": month,
            "years_used": int(dist["count"]),
            "stats": dist,
            "mean_tmax": compute_distribution(np.array(max_means_history[month], dtype=float)),
            "mean_tmin": compute_distribution(np.array(min_means_history[month], dtype=float)),
            "diurnal_range": compute_distribution(np.array(diurnal_history[month], dtype=float)),
            "absolute_max": max(absolute_max_by_month[month], default=None),
            "absolute_min": min(absolute_min_by_month[month], default=None),
        }

    all_temp_obs = list(t2m_obs) + list(t2m_max_obs or []) + list(t2m_min_obs or [])
    total_valid = len(by_date_t2m) + len(by_date_max) + len(by_date_min)
    total_obs = len(all_temp_obs)
    coverage_pct = round((total_valid / total_obs * 100), 2) if total_obs > 0 else 0.0
    annual_means = []
    for year in years_sorted:
        dates = [date for date in by_date_t2m if int(date[:4]) == year]
        expected_days = sum(get_expected_month_days(year, month) for month in range(1, 13))
        if expected_days and len(dates) / expected_days >= completeness_threshold:
            annual_means.append(float(np.mean([by_date_t2m[date] for date in dates])))

    return {
        "parameter": "T2M",
        "unit": "C",
        "formula_version": FORMULA_VERSION,
        "years_used": len(years_sorted),
        "total_observations": total_obs,
        "valid_observations": total_valid,
        "missing_observations": total_obs - total_valid,
        "coverage_percent": coverage_pct,
        "annual_historical": compute_distribution(np.array(annual_means, dtype=float)),
        "monthly_historical": monthly_historical,
        "monthly_series": monthly_series,
    }


def summarize_parameter(
    observations: List[Dict[str, Any]],
    parameter_name: str,
    unit: str,
    completeness_threshold: float = 0.9,
) -> Dict[str, Any]:
    """
    Generic summary for RH2M, ALLSKY_SFC_SW_DWN, etc.:
    Computes monthly means, annual distributions, and historical percentiles.
    """
    by_year_month: Dict[int, Dict[int, List[float]]] = {}
    total_valid = 0
    total_missing = 0

    for obs in observations:
        d = obs.get("dateLabel") or obs.get("date", "")[:10]
        val = obs.get("value")
        quality = obs.get("quality")

        year = int(d[:4])
        month = int(d[5:7])

        if year not in by_year_month:
            by_year_month[year] = {m: [] for m in range(1, 13)}

        if quality == "ok" and val is not None:
            by_year_month[year][month].append(float(val))
            total_valid += 1
        else:
            total_missing += 1

    years_sorted = sorted(by_year_month.keys())
    monthly_series: List[Dict[str, Any]] = []
    month_means_history: Dict[int, List[float]] = {m: [] for m in range(1, 13)}

    for year in years_sorted:
        for month in range(1, 13):
            vals = by_year_month[year][month]
            expected = get_expected_month_days(year, month)
            valid_days = len(vals)
            is_complete = (valid_days / expected) >= completeness_threshold if expected > 0 else False

            mean_val = float(np.mean(vals)) if valid_days > 0 else None
            monthly_series.append({
                "year": year,
                "month": month,
                "mean": round(mean_val, 2) if mean_val is not None else None,
                "valid_days": valid_days,
                "expected_days": expected,
                "is_complete": is_complete,
            })
            if is_complete and mean_val is not None:
                month_means_history[month].append(mean_val)

    monthly_historical: Dict[str, Any] = {}
    for month in range(1, 13):
        dist = compute_distribution(np.array(month_means_history[month], dtype=float))
        monthly_historical[str(month)] = {
            "month": month,
            "years_used": int(dist["count"]),
            "stats": dist,
        }

    annual_means = []
    for year in years_sorted:
        annual_values = [value for month_values in by_year_month[year].values() for value in month_values]
        expected_days = sum(get_expected_month_days(year, month) for month in range(1, 13))
        if expected_days and len(annual_values) / expected_days >= completeness_threshold:
            annual_means.append(float(np.mean(annual_values)))

    total_count = total_valid + total_missing
    coverage_pct = round((total_valid / total_count * 100), 2) if total_count > 0 else 0.0

    return {
        "parameter": parameter_name,
        "unit": unit,
        "formula_version": FORMULA_VERSION,
        "years_used": len(years_sorted),
        "total_observations": total_count,
        "valid_observations": total_valid,
        "missing_observations": total_missing,
        "coverage_percent": coverage_pct,
        "annual_historical": compute_distribution(np.array(annual_means, dtype=float)),
        "monthly_historical": monthly_historical,
        "monthly_series": monthly_series,
    }


def rank_data(arr: np.ndarray) -> np.ndarray:
    """
    Assign ranks to 1D array data with average ranks for tied values (pure NumPy).
    """
    arr = np.asarray(arr)
    n = len(arr)
    if n == 0:
        return np.array([], dtype=float)
    sorter = np.argsort(arr)
    inv = np.empty(n, dtype=int)
    inv[sorter] = np.arange(n)
    arr_sorted = arr[sorter]
    obs = np.r_[True, arr_sorted[1:] != arr_sorted[:-1]]
    dense = obs.cumsum()[inv]
    count = np.bincount(dense)
    cumsum = count.cumsum()
    return cumsum[dense] - count[dense] / 2.0 + 0.5


def compute_mann_whitney_u(x: np.ndarray, y: np.ndarray) -> Dict[str, Any]:
    """
    Computes Mann-Whitney U rank-sum test between two independent climate period samples.
    Returns U statistic, standardized z-score, and two-sided asymptotic p-value.
    """
    x_valid = x[~np.isnan(x)]
    y_valid = y[~np.isnan(y)]
    n1 = len(x_valid)
    n2 = len(y_valid)

    if n1 == 0 or n2 == 0:
        return {
            "u1": None,
            "u2": None,
            "u": None,
            "z": None,
            "p_value": None,
            "n1": n1,
            "n2": n2,
            "is_significant": False,
        }

    combined = np.concatenate([x_valid, y_valid])
    ranks = rank_data(combined)
    r1 = float(np.sum(ranks[:n1]))
    r2 = float(np.sum(ranks[n1:]))

    u1 = r1 - (n1 * (n1 + 1)) / 2.0
    u2 = r2 - (n2 * (n2 + 1)) / 2.0
    u = min(u1, u2)

    mu_u = (n1 * n2) / 2.0
    sigma_u = math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12.0) if (n1 + n2 + 1) > 0 else 1.0

    z = (u1 - mu_u) / sigma_u if sigma_u > 0 else 0.0
    p_value = 2.0 * (1.0 - 0.5 * (1.0 + math.erf(abs(z) / math.sqrt(2.0))))

    return {
        "u1": round(u1, 2),
        "u2": round(u2, 2),
        "u": round(u, 2),
        "z": round(z, 3),
        "p_value": round(p_value, 4),
        "n1": n1,
        "n2": n2,
        "is_significant": bool(p_value < 0.05),
    }


def compute_welch_t(x: np.ndarray, y: np.ndarray) -> Dict[str, Any]:
    """
    Computes Welch's t-test for unequal variances between two independent climate period samples.
    """
    x_valid = x[~np.isnan(x)]
    y_valid = y[~np.isnan(y)]
    n1 = len(x_valid)
    n2 = len(y_valid)

    if n1 < 2 or n2 < 2:
        return {
            "t": None,
            "df": None,
            "mean1": None,
            "mean2": None,
            "mean_diff": None,
            "p_approx": None,
            "n1": n1,
            "n2": n2,
        }

    m1 = float(np.mean(x_valid))
    m2 = float(np.mean(y_valid))
    v1 = float(np.var(x_valid, ddof=1))
    v2 = float(np.var(y_valid, ddof=1))

    se_diff = math.sqrt(v1 / n1 + v2 / n2) if (v1 / n1 + v2 / n2) > 0 else 1e-9
    t_stat = (m2 - m1) / se_diff

    # Welch-Satterthwaite degrees of freedom
    num = (v1 / n1 + v2 / n2) ** 2
    denom = ((v1 / n1) ** 2) / (n1 - 1) + ((v2 / n2) ** 2) / (n2 - 1)
    df = num / denom if denom > 0 else 1.0

    p_approx = 2.0 * (1.0 - 0.5 * (1.0 + math.erf(abs(t_stat) / math.sqrt(2.0))))

    return {
        "t": round(t_stat, 3),
        "df": round(df, 1),
        "mean1": round(m1, 2),
        "mean2": round(m2, 2),
        "mean_diff": round(m2 - m1, 2),
        "p_approx": round(p_approx, 4),
        "n1": n1,
        "n2": n2,
    }


CROP_TRANSITIONS: Dict[str, Dict[str, Any]] = {
    "aman-mustard": {
        "id": "aman-mustard",
        "previous_crop": "T. Aman Rice",
        "next_crop": "Mustard",
        "name_en": "Aman Rice to Mustard",
        "name_bn": "আমন ধান থেকে সরিষা",
        "sowing_month": 11,
        "sowing_days_start": 1,
        "sowing_days_end": 20,
        "sowing_window_label": "Nov 1 – Nov 20",
        "harvest_window_label": "Late Oct – Mid Nov",
        "min_consecutive_dry_days": 5,
        "description_en": "Transition between monsoon Aman harvest and winter Rabi Mustard sowing. Excessive residual moisture delays tillage, while sowing past late November causes severe flowering heat stress.",
        "description_bn": "আমন ধান কাটার পর রবি মৌসুমের সরিষা চাষের গুরুত্বপূর্ণ ট্রানজিশন উইন্ডো। দেরিতে বৃষ্টি হলে জমি তৈরিতে বিলম্ব ঘটে, এবং ২০ নভেম্বরের পর সরিষা বুনলে ফলন কমে যায়।",
    },
    "boro-aus": {
        "id": "boro-aus",
        "previous_crop": "Boro Rice",
        "next_crop": "Aus Rice",
        "name_en": "Boro Rice to Aus Rice",
        "name_bn": "বোরো ধান থেকে আউশ ধান",
        "sowing_month": 4,
        "sowing_days_start": 1,
        "sowing_days_end": 20,
        "sowing_window_label": "Apr 1 – Apr 20",
        "harvest_window_label": "Late Mar – Early Apr",
        "min_consecutive_dry_days": 4,
        "description_en": "Spring transition between irrigated Boro harvest and pre-monsoon direct-seeded Aus.",
        "description_bn": "সেচভিত্তিক বোরো ধান কাটার পর প্রাক-বর্ষা আউশ ধান বপনের অন্তর্বর্তীকালীন পরিকল্পনা।",
    },
}


DUPLICATE_VALUE_POLICY = (
    "Identical valid values for one date collapse to that value. "
    "Conflicting valid values are not averaged and are not selected by input order. "
    "The date is excluded from valid coverage and interrupts a consecutive dry run. "
    "Conflicts are listed in duplicate_conflicts."
)
SOWING_YEAR_ELIGIBILITY = 0.9


def _index_parameter_observations(
    observations: List[Dict[str, Any]],
    parameter: str,
    reject_negative: bool = False,
) -> tuple:
    """Index one value per date.

    Rainfall sets reject_negative because PRECTOTCORR below zero is not a
    physical daily amount. Temperature does not.
    """
    grouped: Dict[str, List[float]] = {}
    for obs in observations:
        label = obs.get("dateLabel")
        if not label:
            continue
        value = finite_observation_value(obs)
        if value is None:
            continue
        if reject_negative and value < 0:
            continue
        grouped.setdefault(str(label), []).append(value)

    indexed: Dict[str, float] = {}
    conflicts: List[Dict[str, Any]] = []
    for label in sorted(grouped):
        distinct = sorted(set(grouped[label]))
        if len(distinct) == 1:
            indexed[label] = distinct[0]
        else:
            conflicts.append({
                "parameter": parameter,
                "dateLabel": label,
                "distinct_values": distinct,
                "resolution": "excluded_unresolved_conflict",
            })
    return indexed, conflicts


def sowing_window_rainfall_coverage(
    rainfall_obs: List[Dict[str, Any]],
    crop_transition: str = "aman-mustard",
) -> Dict[str, Any]:
    """Coverage against every expected sowing-window calendar date.

    The denominator is the configured window length times each year present in
    the rainfall payload. Valid days are distinct dates, so duplicates do not
    add coverage.     Absent, non-ok, sentinel, negative, non-finite, and conflicting days are missing.
    """
    config = CROP_TRANSITIONS.get(crop_transition, CROP_TRANSITIONS["aman-mustard"])
    month = int(config["sowing_month"])
    day_start = int(config["sowing_days_start"])
    day_end = int(config["sowing_days_end"])
    valid_dates, _conflicts = _index_parameter_observations(
        rainfall_obs, "PRECTOTCORR", reject_negative=True
    )

    years = set()
    for obs in rainfall_obs:
        label = str(obs.get("dateLabel") or "")
        if len(label) < 4:
            continue
        try:
            years.add(int(label[0:4]))
        except ValueError:
            continue

    expected_dates = [
        f"{year:04d}-{month:02d}-{day:02d}"
        for year in sorted(years)
        for day in range(day_start, day_end + 1)
    ]
    valid = sum(1 for label in expected_dates if label in valid_dates)
    expected = len(expected_dates)
    missing = expected - valid
    coverage = round((valid / expected) * 100, 2) if expected else 0.0
    return {
        "expected_observations": expected,
        "valid_observations": valid,
        "missing_observations": missing,
        "coverage_percent": coverage,
        "coverage_basis": "expected_sowing_window_calendar_days",
        "coverage_parameter": "PRECTOTCORR",
    }


def summarize_handoff(
    rainfall_obs: List[Dict[str, Any]],
    t2m_min_obs: Optional[List[Dict[str, Any]]] = None,
    t2m_obs: Optional[List[Dict[str, Any]]] = None,
    crop_transition: str = "aman-mustard",
    period1_years: tuple = (2001, 2012),
    period2_years: tuple = (2013, 2025),
) -> Dict[str, Any]:
    """
    Analyzes historical handoff dynamics between sequential cropping seasons.
    Evaluates sowing window rainfall cessation, temperature thresholds,
    and shifts between two climatological periods (e.g. 2001-2012 vs 2013-2025).
    """
    config = CROP_TRANSITIONS.get(crop_transition, CROP_TRANSITIONS["aman-mustard"])
    s_month = config["sowing_month"]
    s_start = config["sowing_days_start"]
    s_end = config["sowing_days_end"]
    min_dry_run = config["min_consecutive_dry_days"]

    # Identical duplicates collapse. Conflicting values are excluded, independent of order.
    rain_by_date, rain_conflicts = _index_parameter_observations(
        rainfall_obs, "PRECTOTCORR", reject_negative=True
    )
    tmin_by_date, tmin_conflicts = _index_parameter_observations(t2m_min_obs or [], "T2M_MIN")
    t2m_by_date, t2m_conflicts = _index_parameter_observations(t2m_obs or [], "T2M")
    duplicate_conflicts = rain_conflicts + tmin_conflicts + t2m_conflicts

    payload_years = []
    for obs in rainfall_obs:
        label = str(obs.get("dateLabel") or "")
        if len(label) < 4:
            continue
        try:
            payload_years.append(int(label[0:4]))
        except ValueError:
            continue
    if not payload_years:
        return {
            "transition_id": crop_transition,
            "config": config,
            "years_used": 0,
            "evidence_status": "no_data",
            "yearly_series": [],
            "excluded_years": [],
            "duplicate_conflicts": duplicate_conflicts,
            "duplicate_policy": DUPLICATE_VALUE_POLICY,
        }

    start_year = min(payload_years)
    end_year = max(payload_years)
    all_years = list(range(start_year, end_year + 1))

    yearly_records: List[Dict[str, Any]] = []
    excluded_years: List[Dict[str, Any]] = []

    for year in all_years:
        # 1. Sowing window dates (e.g. Nov 1 - Nov 20)
        sowing_dates = [f"{year:04d}-{s_month:02d}-{d:02d}" for d in range(s_start, s_end + 1)]
        expected_sowing_days = len(sowing_dates)

        valid_sowing_days = 0
        missing_sowing_dates = []
        dry_days_count = 0
        wet_days_count = 0
        sowing_rain_vals = []

        # Consecutive dry run tracker: never bridge an unobserved day
        max_dry_run = 0
        current_dry_run = 0

        for d in sowing_dates:
            val = rain_by_date.get(d)
            if val is not None:
                valid_sowing_days += 1
                sowing_rain_vals.append(val)
                if val < 1.0:
                    dry_days_count += 1
                    current_dry_run += 1
                    if current_dry_run > max_dry_run:
                        max_dry_run = current_dry_run
                else:
                    wet_days_count += 1
                    current_dry_run = 0  # Rain >= 1.0mm resets streak
            else:
                # Missing, unobserved, null, or sentinel: strictly reset dry run and record missing date
                missing_sowing_dates.append(d)
                current_dry_run = 0  # Unobserved day interrupts sequence; never bridge!

        coverage_pct_sowing = (
            round((valid_sowing_days / expected_sowing_days) * 100, 1)
            if expected_sowing_days > 0
            else 0.0
        )
        if valid_sowing_days < (expected_sowing_days * SOWING_YEAR_ELIGIBILITY):
            excluded_years.append({
                "year": year,
                "reason": "below_sowing_window_coverage_threshold",
                "eligibility_threshold": SOWING_YEAR_ELIGIBILITY,
                "denominator": "expected_sowing_window_calendar_days",
                "expected_days_sowing": expected_sowing_days,
                "valid_days_sowing": valid_sowing_days,
                "missing_days_sowing": len(missing_sowing_dates),
                "coverage_pct_sowing": coverage_pct_sowing,
                "included_in_yearly_series": False,
            })
            continue

        total_sowing_rain = float(np.sum(sowing_rain_vals))
        workable_window = max_dry_run >= min_dry_run

        # T2M_MIN during sowing window
        sowing_tmins = [tmin_by_date[d] for d in sowing_dates if d in tmin_by_date]
        mean_tmin = float(np.mean(sowing_tmins)) if sowing_tmins else None
        min_tmin = float(np.min(sowing_tmins)) if sowing_tmins else None

        # October metrics (harvest and late rainfall before mustard sowing)
        oct_dates = [f"{year:04d}-10-{d:02d}" for d in range(1, 32)]
        oct_rain_vals = [rain_by_date[d] for d in oct_dates if d in rain_by_date]
        oct_total_rain = float(np.sum(oct_rain_vals)) if len(oct_rain_vals) >= 28 else None
        oct_rain_days = sum(1 for r in oct_rain_vals if r >= 1.0) if len(oct_rain_vals) >= 28 else None

        # Late October rainfall (Oct 16-31, 16 days) - critical for field drainage
        oct_late_dates = [f"{year:04d}-10-{d:02d}" for d in range(16, 32)]
        oct_late_rain_vals = [rain_by_date[d] for d in oct_late_dates if d in rain_by_date]
        oct_late_rain = float(np.sum(oct_late_rain_vals)) if len(oct_late_rain_vals) >= 14 else None

        # Full November rainfall
        nov_dates = [f"{year:04d}-11-{d:02d}" for d in range(1, 31)]
        nov_rain_vals = [rain_by_date[d] for d in nov_dates if d in rain_by_date]
        nov_total_rain = float(np.sum(nov_rain_vals)) if len(nov_rain_vals) >= 27 else None
        nov_rain_days = sum(1 for r in nov_rain_vals if r >= 1.0) if len(nov_rain_vals) >= 27 else None

        yearly_records.append({
            "year": year,
            "expected_days_sowing": expected_sowing_days,
            "valid_days_sowing": valid_sowing_days,
            "missing_days_sowing": len(missing_sowing_dates),
            "missing_dates_sowing": missing_sowing_dates,
            "coverage_pct_sowing": coverage_pct_sowing,
            "dry_days_sowing": dry_days_count,
            "wet_days_sowing": wet_days_count,
            "total_sowing_rain": round(total_sowing_rain, 2),
            "max_dry_run": max_dry_run,
            "workable_window": workable_window,
            "mean_tmin_sowing": round(mean_tmin, 2) if mean_tmin is not None else None,
            "min_tmin_sowing": round(min_tmin, 2) if min_tmin is not None else None,
            "oct_total_rain": round(oct_total_rain, 2) if oct_total_rain is not None else None,
            "oct_late_rain": round(oct_late_rain, 2) if oct_late_rain is not None else None,
            "oct_rain_days": oct_rain_days,
            "nov_total_rain": round(nov_total_rain, 2) if nov_total_rain is not None else None,
            "nov_rain_days": nov_rain_days,
        })

    total_valid_years = len(yearly_records)
    if total_valid_years == 0:
        return {
            "transition_id": crop_transition,
            "config": config,
            "years_used": 0,
            "evidence_status": "insufficient_data",
            "yearly_series": [],
            "excluded_years": excluded_years,
            "yearly_eligibility": {
                "threshold": SOWING_YEAR_ELIGIBILITY,
                "denominator": "expected_sowing_window_calendar_days",
                "eligible_year_count": 0,
                "excluded_year_count": len(excluded_years),
                "note": (
                    "Years below the coverage threshold are omitted from yearly_series and from "
                    "frequency statistics. Envelope coverage still counts their expected days. "
                    "Exclusion is a completeness rule, not an agricultural outcome."
                ),
            },
            "duplicate_conflicts": duplicate_conflicts,
            "duplicate_policy": DUPLICATE_VALUE_POLICY,
        }

    # Aggregate 25-year Climatological Distributions
    sowing_dry_arr = np.array([r["dry_days_sowing"] for r in yearly_records], dtype=float)
    sowing_rain_arr = np.array([r["total_sowing_rain"] for r in yearly_records], dtype=float)
    sowing_max_run_arr = np.array([r["max_dry_run"] for r in yearly_records], dtype=float)
    sowing_tmin_arr = np.array([r["mean_tmin_sowing"] for r in yearly_records if r["mean_tmin_sowing"] is not None], dtype=float)
    oct_rain_arr = np.array([r["oct_total_rain"] for r in yearly_records if r["oct_total_rain"] is not None], dtype=float)
    oct_late_rain_arr = np.array([r["oct_late_rain"] for r in yearly_records if r["oct_late_rain"] is not None], dtype=float)
    nov_rain_arr = np.array([r["nov_total_rain"] for r in yearly_records if r["nov_total_rain"] is not None], dtype=float)

    workable_years_count = sum(1 for r in yearly_records if r["workable_window"])
    workable_prob_pct = round((workable_years_count / total_valid_years) * 100, 1)

    # Period Comparison (e.g. 2001-2012 vs 2013-2025)
    p1_start, p1_end = period1_years
    p2_start, p2_end = period2_years

    p1_records = [r for r in yearly_records if p1_start <= r["year"] <= p1_end]
    p2_records = [r for r in yearly_records if p2_start <= r["year"] <= p2_end]

    def compare_metric(name: str, p1_vals: np.ndarray, p2_vals: np.ndarray, unit: str) -> Dict[str, Any]:
        p1_v = p1_vals[~np.isnan(p1_vals)]
        p2_v = p2_vals[~np.isnan(p2_vals)]
        p1_mean = float(np.mean(p1_v)) if len(p1_v) > 0 else None
        p1_median = float(np.median(p1_v)) if len(p1_v) > 0 else None
        p2_mean = float(np.mean(p2_v)) if len(p2_v) > 0 else None
        p2_median = float(np.median(p2_v)) if len(p2_v) > 0 else None

        delta_mean = round(p2_mean - p1_mean, 2) if (p1_mean is not None and p2_mean is not None) else None
        delta_pct = round((delta_mean / p1_mean) * 100, 1) if (p1_mean and p1_mean != 0 and delta_mean is not None) else None

        mw = compute_mann_whitney_u(p1_v, p2_v)
        wt = compute_welch_t(p1_v, p2_v)

        if mw["p_value"] is not None and mw["p_value"] < 0.05:
            sig_label = "statistically_distinguishable"
        else:
            sig_label = "within_historical_variability"

        return {
            "metric": name,
            "unit": unit,
            "period1": {
                "label": f"{p1_start}–{p1_end}",
                "years_count": len(p1_v),
                "mean": round(p1_mean, 2) if p1_mean is not None else None,
                "median": round(p1_median, 2) if p1_median is not None else None,
            },
            "period2": {
                "label": f"{p2_start}–{p2_end}",
                "years_count": len(p2_v),
                "mean": round(p2_mean, 2) if p2_mean is not None else None,
                "median": round(p2_median, 2) if p2_median is not None else None,
            },
            "shift": {
                "delta_mean": delta_mean,
                "delta_pct": delta_pct,
                "evidence_label": sig_label,
            },
            "statistical_tests": {
                "mann_whitney_u": mw,
                "welch_t": wt,
            },
        }

    period_comparisons = {
        "sowing_dry_days": compare_metric(
            "Nov 1–20 Sowing Window Dry Days",
            np.array([r["dry_days_sowing"] for r in p1_records], dtype=float),
            np.array([r["dry_days_sowing"] for r in p2_records], dtype=float),
            "days",
        ),
        "oct_late_rain": compare_metric(
            "Late October Rain (Oct 16–31)",
            np.array([r["oct_late_rain"] for r in p1_records if r["oct_late_rain"] is not None], dtype=float),
            np.array([r["oct_late_rain"] for r in p2_records if r["oct_late_rain"] is not None], dtype=float),
            "mm",
        ),
        "oct_total_rain": compare_metric(
            "October Total Rainfall",
            np.array([r["oct_total_rain"] for r in p1_records if r["oct_total_rain"] is not None], dtype=float),
            np.array([r["oct_total_rain"] for r in p2_records if r["oct_total_rain"] is not None], dtype=float),
            "mm",
        ),
        "nov_total_rain": compare_metric(
            "November Total Rainfall",
            np.array([r["nov_total_rain"] for r in p1_records if r["nov_total_rain"] is not None], dtype=float),
            np.array([r["nov_total_rain"] for r in p2_records if r["nov_total_rain"] is not None], dtype=float),
            "mm",
        ),
        "sowing_mean_tmin": compare_metric(
            "Sowing Window Minimum Temp (T2M_MIN)",
            np.array([r["mean_tmin_sowing"] for r in p1_records if r["mean_tmin_sowing"] is not None], dtype=float),
            np.array([r["mean_tmin_sowing"] for r in p2_records if r["mean_tmin_sowing"] is not None], dtype=float),
            "C",
        ),
    }

    return {
        "transition_id": crop_transition,
        "config": config,
        "formula_version": FORMULA_VERSION,
        "years_used": total_valid_years,
        "climatology_period": f"{start_year}–{end_year}",
        "evidence_status": "robust_sample" if total_valid_years >= 20 else "insufficient_sample",
        "sowing_opportunity": {
            "workable_window_frequency_pct": workable_prob_pct,
            "years_with_workable_window": workable_years_count,
            "total_years": total_valid_years,
            "sowing_dry_days_distribution": compute_distribution(sowing_dry_arr),
            "sowing_total_rain_distribution": compute_distribution(sowing_rain_arr),
            "sowing_max_dry_run_distribution": compute_distribution(sowing_max_run_arr),
            "sowing_tmin_distribution": compute_distribution(sowing_tmin_arr),
            "oct_total_rain_distribution": compute_distribution(oct_rain_arr),
            "oct_late_rain_distribution": compute_distribution(oct_late_rain_arr),
            "nov_total_rain_distribution": compute_distribution(nov_rain_arr),
        },
        "period_comparison": {
            "period1_label": f"{p1_start}–{p1_end} ({len(p1_records)} years)",
            "period2_label": f"{p2_start}–{p2_end} ({len(p2_records)} years)",
            "metrics": period_comparisons,
        },
        "yearly_series": yearly_records,
        "excluded_years": excluded_years,
        "yearly_eligibility": {
            "threshold": SOWING_YEAR_ELIGIBILITY,
            "denominator": "expected_sowing_window_calendar_days",
            "eligible_year_count": total_valid_years,
            "excluded_year_count": len(excluded_years),
            "note": (
                "Years below the coverage threshold are omitted from yearly_series and from "
                "frequency statistics. Envelope coverage still counts their expected days. "
                "Exclusion is a completeness rule, not an agricultural outcome."
            ),
        },
        "duplicate_conflicts": duplicate_conflicts,
        "duplicate_policy": DUPLICATE_VALUE_POLICY,
        "scientific_disclosures": {
            "operational_proxy_definition": "Five consecutive dry days (< 1.0 mm/day) is a project-selected operational proxy for land tillage workability; not an official government agronomic standard or field readiness guarantee.",
            "wet_day_definition": "WMO threshold: valid daily precipitation >= 1.0 mm is classified as a wet day; < 1.0 mm is a dry day.",
            "time_standard": "NASA POWER Local Solar Time (LST) solar-day boundary.",
            "sample_disclosure": f"Based on {total_valid_years} verified historical years ({start_year}–{end_year}) of NASA POWER Daily Agroclimatology point observations.",
            "period_comparison_disclosure": "Exploratory retrospective climatological comparison (Period 1: 2001–2012 vs. Period 2: 2013–2025). P-values and test statistics are descriptive and exploratory; does not establish climate change attribution or agronomic significance.",
            "disclaimer": "Descriptive historical evidence only. Historical frequencies describe past observations and do not constitute future probabilities or yield guarantees. Local field conditions, soil percolation, and seed variety must be verified on-ground.",
        },
    }
