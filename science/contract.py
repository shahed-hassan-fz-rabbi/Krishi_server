"""
JSON Input/Output Contract for Python Scientific Processing.
"""
from typing import Any, Dict, List, Optional
import json

SUPPORTED_DISTRICTS = {"chattogram", "cumilla"}
SUPPORTED_PARAMETERS = {
    "PRECTOTCORR",
    "T2M",
    "T2M_MAX",
    "T2M_MIN",
    "RH2M",
    "ALLSKY_SFC_SW_DWN",
}

LIMITATIONS_NOTE = (
    "NASA POWER Local Solar Time (LST) observations. Gridded point interpolation resolution ~0.5 deg. "
    "Descriptive historical statistics only. No predictive crop yield or sowing guarantees."
)


def validate_input_snapshot(payload: Dict[str, Any]) -> List[str]:
    errors = []
    if not isinstance(payload, dict):
        return ["Input payload must be a JSON object"]

    district = payload.get("district")
    if not district or district not in SUPPORTED_DISTRICTS:
        errors.append(f"Invalid or unsupported district: '{district}'. Supported: {sorted(SUPPORTED_DISTRICTS)}")

    observations = payload.get("observations")
    if not isinstance(observations, list):
        errors.append("'observations' must be an array of observation objects")
    elif len(observations) == 0:
        errors.append("'observations' list cannot be empty")

    return errors


def build_output_envelope(
    district: str,
    parameter: str,
    unit: str,
    summary_data: Dict[str, Any],
    dataset_provenance: str = "nasa:power:daily:point",
    time_standard: str = "LST",
) -> Dict[str, Any]:
    return {
        "success": True,
        "meta": {
            "district": district,
            "parameter": parameter,
            "unit": unit,
            "dataset_provenance": dataset_provenance,
            "time_standard": time_standard,
            "formula_version": summary_data.get("formula_version", "v1.0.0-phase3"),
            "years_used": summary_data.get("years_used", 0),
            "total_observations": summary_data.get("total_observations", 0),
            "valid_observations": summary_data.get("valid_observations", 0),
            "missing_observations": summary_data.get("missing_observations", 0),
            "coverage_percent": summary_data.get("coverage_percent", 0.0),
            "limitations": LIMITATIONS_NOTE,
        },
        "data": summary_data,
    }
