# Krishi Mama — Python Scientific Processing Engine

**Package:** `server/science/`  
**Formula Version:** `v1.0.0-phase3`  
**Runtime:** Python 3.11+ / NumPy 2.x  
**Data Source:** NASA POWER Daily Agroclimatology Point Dataset (`nasa:power:daily:point`)  
**Time Standard:** Local Solar Time (`LST`) — solar-day boundary, not Bangladesh Standard Time (BST, UTC+6).

---

## 1. Scientific Philosophy & Principles

1. **Deterministic Calculations:** All analytical results, totals, means, and percentiles are produced through pure, repeatable NumPy calculations. Values are never generated, estimated, or modified by LLMs.
2. **Missing-Data Integrity:** Missing values (sentinels such as `-999`, nulls, absent days) are strictly excluded from mathematical summations and averages. Missing observations are **NEVER converted to zero**.
3. **Incomplete-Period Accounting:** A 90% completeness threshold is enforced. Any month or year with fewer than 90% of expected calendar days validly recorded is flagged as `is_complete: false` and excluded from historical normals calculations. Temperature absolute monthly extrema are currently calculated from any available valid daily extrema, even when the containing month is incomplete; consumers should treat these as observed extrema, not complete-month baselines.
4. **Descriptive Evidence Only:** In Phase 3, this engine produces descriptive statistics and historical percentiles only. It does not compute predictive risk categories, yield guarantees, or synthetic sowing dates.

---

## 2. Statistical Formulas & Methodologies

### 2.1 Percentile Method & Evidence Guardrails
Percentiles ($P_{25}, P_{50}, P_{75}, P_{90}$) are computed using standard **linear interpolation** (`np.percentile(arr, q, method="linear")`, equivalent to Hyndman & Fan Type 7, the standard in SciPy, R, and Excel).
$$\text{Index} = (N - 1) \times \frac{q}{100}$$
Value is interpolated linearly between closest data ranks.

* **Sample Size Evidence Guardrail:** A single year or limited historical records ($N < 5$ years) are mathematically insufficient for robust climatological percentile baselines. When $N < 5$, percentiles describe only the limited sample and the engine returns `evidence_status: "insufficient_sample"` alongside an explicit limitation disclosure.

### 2.2 Rainfall Statistics (`PRECTOTCORR`, `mm/day`)
* **Daily Rainfall:** Pure daily observations in `mm/day`.
* **Monthly Rainfall Total:**
  $$\text{Total}_{\text{month}} = \sum_{i=1}^{N_{\text{valid}}} \text{Rainfall}_i$$
* **Annual Rainfall Total:** Sum of all 12 monthly totals for a complete year.
* **Project-Selected Wet-Day Threshold:** Count valid observed days in a month where $\text{Rainfall} \ge 1.0\text{ mm}$. This threshold is a descriptive convention for this project, not an agronomic threshold or crop-risk rule.
* **Project-Selected Dry-Day Count:** Among valid observed days only, count days where $\text{Rainfall} < 1.0\text{ mm}$. Sentinel, absent, null, and otherwise invalid observations are excluded from both counts; `valid_days` is the denominator for any frequency rate. The current engine reports counts, not a percentage frequency.
* **Historical Monthly Normals:** For each calendar month, calculate that month's total separately in each year with at least 90% of expected days valid. The reported mean and percentiles ($P_{25}, P_{50}, P_{75}, P_{90}$) then treat each qualifying year-month total equally; they are not pooled daily totals. Percentiles use Type 7 linear interpolation and are marked insufficient when fewer than five year values are available.

### 2.2.1 Annual Weighting
Annual rainfall distributions contain one complete-year total per year (at least 90% of expected daily observations); annual temperature and generic-parameter distributions contain one complete-year mean per qualifying year. The summary mean therefore gives each qualifying year equal weight, regardless of the number of valid days above the completeness threshold. The exposed annual series also retains incomplete-year partial totals with `is_complete: false`; those values are excluded from annual historical distributions and must not be presented as complete-year totals.

The 90% annual/seasonal coverage rule is an aggregate period denominator: missing days may be clustered in one month while the whole year still meets 90%. In that case a rainfall total can omit a substantial sub-period and remain eligible for the annual distribution. The completeness flag reports coverage by this rule; it is not a guarantee that gaps are evenly distributed or scientifically harmless. Review this policy before using annual totals as a strong baseline.

The top-level `years_used` field currently reports the number of distinct years represented in the input, not the number of complete years in every statistic. For actual statistic sample sizes, use `annual_historical.count` and the relevant month/season `years_used` value.

### 2.3 Meteorological Seasons (Bangladesh Climatological Cycle)
Seasons are defined following the standard 4-season climatological cycle recognized by the **Bangladesh Meteorological Department (BMD)** and national agro-ecological zoning:
1. **Winter (`winter`):** December to February (Dec–Feb, 3 months) — Rabi crop season, cool & dry.
   * *Climatological Season Boundary:* Winter is calculated across the calendar-year boundary. For Winter associated with year $Y$ (e.g. Winter 2020–2021, ending year 2021), the grouping is:
     $$\text{Winter}_{Y} = \text{Dec}_{Y-1} + \text{Jan}_{Y} + \text{Feb}_{Y}$$
     December of year $Y$ is **NEVER** grouped with January/February of year $Y$.
2. **Pre-Monsoon (`pre_monsoon`):** March to May (Mar–May, 3 months) — Hot pre-monsoon season, thunderstorms (Kalbaishakhi).
3. **Monsoon (`monsoon`):** June to September (Jun–Sep, 4 months) — South-west monsoon, main rainy season (Kharif-2).
4. **Post-Monsoon (`post_monsoon`):** October to November (Oct–Nov, 2 months) — Retreating monsoon, transitional period.

Seasonal totals are calculated by summing rainfall across the constituent calendar months, and historical distributions ($P_{25}, P_{50}, P_{75}, P_{90}$) are derived across all valid years.

### 2.4 Temperature Statistics (`T2M`, `T2M_MAX`, `T2M_MIN`, `°C`)
* **Monthly Mean Temperature:** $\text{mean}(T_{2M})$
* **Monthly Mean Maximum:** $\text{mean}(T_{2M\_MAX})$
* **Monthly Absolute Maximum:** $\max(T_{2M\_MAX})$
* **Monthly Mean Minimum:** $\text{mean}(T_{2M\_MIN})$
* **Monthly Absolute Minimum:** $\min(T_{2M\_MIN})$
* **Diurnal Temperature Range (DTR):**
  $$\text{DTR} = \text{mean}(T_{2M\_MAX}) - \text{mean}(T_{2M\_MIN})$$

### 2.5 Other Parameters
* **Relative Humidity (`RH2M`, `%`):** Monthly and annual means, $P_{25}, P_{50}, P_{75}, P_{90}$.
* **Solar Radiation (`ALLSKY_SFC_SW_DWN`, `MJ/m²/day`):** Monthly daily mean insolation, annual insolation, $P_{25}, P_{50}, P_{75}, P_{90}$.

---

## 3. JSON Contract Specification

### 3.1 Input Snapshot Format
```json
{
  "district": "chattogram",
  "parameters": ["PRECTOTCORR", "T2M", "T2M_MAX", "T2M_MIN"],
  "dateRange": { "start": "2001-01-01", "end": "2025-12-31" },
  "observations": [
    {
      "dateLabel": "2001-01-01",
      "parameter": "PRECTOTCORR",
      "value": 0.0,
      "quality": "ok",
      "unit": "mm/day",
      "timeStandard": "LST"
    }
  ]
}
```

### 3.2 Output Envelope Format
```json
{
  "success": true,
  "meta": {
    "district": "chattogram",
    "parameter": "PRECTOTCORR",
    "unit": "mm/day",
    "dataset_provenance": "nasa:power:daily:point",
    "time_standard": "LST",
    "formula_version": "v1.0.0-phase3",
    "years_used": 25,
    "total_observations": 9131,
    "valid_observations": 9131,
    "missing_observations": 0,
    "coverage_percent": 100.0,
    "limitations": "NASA POWER Local Solar Time (LST) observations. Gridded point interpolation resolution ~0.5 deg. Descriptive historical statistics only."
  },
  "data": { ... }
}
```

---

## 4. CLI Execution

```bash
# Full analysis across all parameters in snapshot:
python server/science/run.py summarize --district chattogram --input snapshot.json --output summary.json

# Filtered parameter analysis:
python server/science/run.py summarize --district cumilla --parameter PRECTOTCORR --input snapshot.json

# Stdin/stdout streaming:
cat snapshot.json | python server/science/run.py summarize --district chattogram --input -
```

---

## 5. Test Suite

Run Python scientific tests:
```bash
python -m unittest discover -s server/science/tests -p "test_*.py"
```
Covers:
1. Known-answer rainfall totals.
2. Known-answer temperature averages.
3. Percentile calculations (linear method).
4. Missing-value handling.
5. Sentinel handling (-999).
6. Incomplete month handling (<90% threshold).
7. Leap-year handling (Feb 29 vs Feb 28).
8. Coverage calculations.
9. Empty datasets handling.
10. Invalid input rejection.
11. District data isolation (Chattogram vs Cumilla).
12. Deterministic repeat calculations.
