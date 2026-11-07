#!/usr/bin/env python3
"""
Krishi Mama — Python Scientific CLI.

Usage:
  python run.py summarize --district chattogram --input input.json [--output output.json]
  python run.py summarize --district chattogram --parameter PRECTOTCORR --input input.json
"""
import argparse
import json
import sys
from pathlib import Path

# Add current dir to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from contract import build_output_envelope, validate_input_snapshot
from stats import (
    summarize_parameter,
    summarize_rainfall,
    summarize_temperature,
    summarize_handoff,
    sowing_window_rainfall_coverage,
)


def main():
    parser = argparse.ArgumentParser(description="Krishi Mama Scientific Analysis CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    summarize_parser = subparsers.add_parser("summarize", help="Generate climate statistical summaries")
    summarize_parser.add_argument("--district", required=True, help="District code (chattogram or cumilla)")
    summarize_parser.add_argument("--parameter", default=None, help="Optional parameter filter (e.g. PRECTOTCORR, T2M)")
    summarize_parser.add_argument("--input", required=True, help="Path to input JSON snapshot (or - for stdin)")
    summarize_parser.add_argument("--output", default=None, help="Path to output JSON file (default stdout)")

    handoff_parser = subparsers.add_parser("handoff", help="Analyze crop transition handoff planning & climate shifts")
    handoff_parser.add_argument("--district", required=True, help="District code (chattogram or cumilla)")
    handoff_parser.add_argument("--crop-transition", default="aman-mustard", help="Crop transition pair (default: aman-mustard)")
    handoff_parser.add_argument("--input", required=True, help="Path to input JSON snapshot (or - for stdin)")
    handoff_parser.add_argument("--output", default=None, help="Path to output JSON file (default stdout)")

    args = parser.parse_args()

    # Read input
    if args.input == "-":
        raw_text = sys.stdin.read()
    else:
        with open(args.input, "r", encoding="utf-8") as f:
            raw_text = f.read()

    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"Error parsing JSON input: {e}\n")
        sys.exit(1)

    errors = validate_input_snapshot(payload)
    if errors:
        sys.stderr.write(f"Validation error: {'; '.join(errors)}\n")
        sys.exit(1)

    district = args.district.lower()
    observations = payload.get("observations", [])

    # Group observations by parameter
    by_param = {}
    for obs in observations:
        p = obs.get("parameter")
        if not p:
            continue
        if p not in by_param:
            by_param[p] = []
        by_param[p].append(obs)

    if args.command == "handoff":
        crop_trans = getattr(args, "crop_transition", "aman-mustard")
        rain_obs = by_param.get("PRECTOTCORR", [])
        tmin_obs = by_param.get("T2M_MIN", [])
        t2m_obs = by_param.get("T2M", [])

        handoff_result = summarize_handoff(
            rainfall_obs=rain_obs,
            t2m_min_obs=tmin_obs,
            t2m_obs=t2m_obs,
            crop_transition=crop_trans,
        )

        # Rainfall sowing-window coverage only. Temperature is not folded into this percentage.
        rainfall_coverage = sowing_window_rainfall_coverage(rain_obs, crop_trans)
        meta_extra = {
            "total_observations": rainfall_coverage["expected_observations"],
            "valid_observations": rainfall_coverage["valid_observations"],
            "missing_observations": rainfall_coverage["missing_observations"],
            "years_used": handoff_result.get("years_used", 0),
            "coverage_percent": rainfall_coverage["coverage_percent"],
            "coverage_basis": rainfall_coverage["coverage_basis"],
            "coverage_parameter": "PRECTOTCORR",
            "formula_version": "v1.0.0-phase3",
        }
        envelope = build_output_envelope(
            district,
            f"HANDOFF_{crop_trans.upper()}",
            "composite",
            {**handoff_result, **meta_extra},
        )
    else:
        target_param = args.parameter

        if target_param:
            param_obs = by_param.get(target_param, [])
            if target_param == "PRECTOTCORR":
                result = summarize_rainfall(param_obs)
                unit = "mm/day"
            elif target_param == "T2M":
                result = summarize_temperature(
                    t2m_obs=param_obs,
                    t2m_max_obs=by_param.get("T2M_MAX"),
                    t2m_min_obs=by_param.get("T2M_MIN"),
                )
                unit = "C"
            elif target_param in ("T2M_MAX", "T2M_MIN"):
                unit = "C"
                result = summarize_parameter(param_obs, target_param, unit)
            elif target_param == "RH2M":
                unit = "%"
                result = summarize_parameter(param_obs, target_param, unit)
            elif target_param == "ALLSKY_SFC_SW_DWN":
                unit = "MJ/m^2/day"
                result = summarize_parameter(param_obs, target_param, unit)
            else:
                sys.stderr.write(f"Unknown or unsupported parameter: {target_param}\n")
                sys.exit(1)

            envelope = build_output_envelope(district, target_param, unit, result)
        else:
            # Full multi-parameter summary
            summaries = {}
            if "PRECTOTCORR" in by_param:
                summaries["rainfall"] = summarize_rainfall(by_param["PRECTOTCORR"])

            if "T2M" in by_param:
                summaries["temperature"] = summarize_temperature(
                    t2m_obs=by_param["T2M"],
                    t2m_max_obs=by_param.get("T2M_MAX"),
                    t2m_min_obs=by_param.get("T2M_MIN"),
                )

            for p, unit in [("RH2M", "%"), ("ALLSKY_SFC_SW_DWN", "MJ/m^2/day")]:
                if p in by_param:
                    summaries[p.lower()] = summarize_parameter(by_param[p], p, unit)

            total_obs = sum(s.get("total_observations", 0) for s in summaries.values())
            valid_obs = sum(s.get("valid_observations", 0) for s in summaries.values())
            missing_obs = sum(s.get("missing_observations", 0) for s in summaries.values())
            years_used = max((s.get("years_used", 0) for s in summaries.values()), default=0)
            cov_pct = round((valid_obs / total_obs * 100), 2) if total_obs > 0 else 0.0

            meta_stats = {
                "total_observations": total_obs,
                "valid_observations": valid_obs,
                "missing_observations": missing_obs,
                "years_used": years_used,
                "coverage_percent": cov_pct,
                "formula_version": "v1.0.0-phase3",
            }

            envelope = build_output_envelope(district, "ALL", "mixed", {**summaries, **meta_stats})

    output_json = json.dumps(envelope, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output_json)
    else:
        print(output_json)


if __name__ == "__main__":
    main()
