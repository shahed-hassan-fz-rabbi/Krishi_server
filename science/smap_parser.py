"""
Scientific HDF5 Parser and Validator for NASA SMAP SPL3SMP_E Version 6.
Enforces strict district separation and verifies pixel coordinates against reference points.
"""

import sys
import json
import os
import math
from datetime import datetime, timezone
import numpy as np
import h5py

def haversine_distance_km(lat1, lon1, lat2, lon2):
    """
    Computes exact great-circle geodesic distance in kilometers on WGS84 mean sphere.
    """
    r_earth = 6371.0088
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r_earth * c

def _read_field(group, name, orbit_suffix):
    """SMAP PM groups suffix variable names with _pm; AM names are unsuffixed."""
    candidate = f"{name}_{orbit_suffix}" if orbit_suffix else name
    return group.get(candidate) or group.get(name)

def _read_optional(dataset, index, fill_value=None):
    if dataset is None:
        return None
    value = float(dataset[index])
    is_exact_fill = fill_value is not None and math.isclose(value, fill_value, rel_tol=0, abs_tol=0.001)
    is_signed_unsigned_fill = fill_value == 65534 and value == -2
    if not math.isfinite(value) or is_exact_fill or is_signed_unsigned_fill:
        return None
    return value

def _read_time(dataset, index):
    if dataset is None:
        return None
    chars = np.asarray(dataset[index]).reshape(-1)
    text = "".join(
        item.decode("utf-8", errors="ignore") if isinstance(item, (bytes, np.bytes_)) else str(item)
        for item in chars
    ).strip("\x00 \t\r\n")
    if not text or text.upper() in {"N/A", "NA", "NAN", "NONE"}:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"Invalid SMAP acquisition timestamp value: {text!r}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

TARGET_DISTRICTS = {
    "cumilla": {
        "name": "Cumilla",
        "refLat": 23.46186,
        "refLon": 91.18503,
        "bbox": {"minLat": 23.0, "maxLat": 23.9, "minLon": 90.7, "maxLon": 91.7},
    },
    "chattogram": {
        "name": "Chattogram",
        "refLat": 22.3384,
        "refLon": 91.8317,
        "bbox": {"minLat": 21.8, "maxLat": 22.9, "minLon": 91.3, "maxLon": 92.4},
    },
}

def inspect_and_parse_smap_hdf5(filepath, target_district=None):
    if not os.path.exists(filepath):
        return {"success": False, "error": f"File not found: {filepath}"}

    result = {
        "success": True,
        "filepath": filepath,
        "filename": os.path.basename(filepath),
        "product": "NASA SMAP SPL3SMP_E Version 6 (Enhanced 9 km EASE-Grid 2.0)",
        "target_district_filter": target_district,
        "metadata": {},
        "districts": {},
    }

    districts_to_evaluate = {}
    if target_district and target_district.lower() in TARGET_DISTRICTS:
        districts_to_evaluate[target_district.lower()] = TARGET_DISTRICTS[target_district.lower()]
    else:
        districts_to_evaluate = TARGET_DISTRICTS

    try:
        with h5py.File(filepath, "r") as h5:
            result["groups"] = list(h5.keys())
            result["source_metadata"] = {
                "history": str(h5.attrs.get("history", "")),
                "history_json": str(h5.attrs.get("history_json", "")),
            }

            for group_name in ["Soil_Moisture_Retrieval_Data_AM", "Soil_Moisture_Retrieval_Data_PM"]:
                if group_name not in h5:
                    continue

                grp = h5[group_name]
                orbit = "AM" if "AM" in group_name else "PM"

                suffix = "pm" if orbit == "PM" else ""
                lat_dset = _read_field(grp, "latitude", suffix)
                lon_dset = _read_field(grp, "longitude", suffix)
                sm_dset = _read_field(grp, "soil_moisture", suffix)
                dca_dset = _read_field(grp, "soil_moisture_dca", suffix)
                qf_dset = _read_field(grp, "retrieval_qual_flag", suffix)
                qf_dca_dset = _read_field(grp, "retrieval_qual_flag_dca", suffix)
                sf_dset = _read_field(grp, "surface_flag", suffix)
                st_dset = _read_field(grp, "surface_temperature", suffix)
                ft_dset = _read_field(grp, "freeze_thaw_fraction", suffix)
                bd_dset = _read_field(grp, "bulk_density", suffix)
                clay_dset = _read_field(grp, "clay_fraction", suffix)
                static_water_dset = _read_field(grp, "static_water_body_fraction", suffix)
                radar_water_dset = _read_field(grp, "radar_water_body_fraction", suffix)
                time_dset = _read_field(grp, "tb_time_utc", suffix)

                if lat_dset is None or lon_dset is None or sm_dset is None:
                    continue
                if qf_dset is None:
                    raise ValueError(f"Missing retrieval_qual_flag for {orbit} pass")

                lats = lat_dset[:]
                lons = lon_dset[:]
                sm = sm_dset[:]
                fill_val = float(sm_dset.attrs.get("_FillValue", -9999.0))
                units = sm_dset.attrs.get("units", "cm**3/cm**3")
                if isinstance(units, bytes):
                    units = units.decode("utf-8")
                valid_min = float(sm_dset.attrs.get("valid_min", 0.02))
                valid_max = float(sm_dset.attrs.get("valid_max", 0.50))

                result["metadata"][orbit] = {
                    "grid_shape": list(sm.shape),
                    "fill_value": fill_val,
                    "units": units,
                    "valid_range": [valid_min, valid_max],
                }

                for dist_code, dist_info in districts_to_evaluate.items():
                    target_lat = dist_info["refLat"]
                    target_lon = dist_info["refLon"]
                    bbox = dist_info["bbox"]

                    if dist_code not in result["districts"]:
                        result["districts"][dist_code] = {
                            "districtCode": dist_code,
                            "districtName": dist_info["name"],
                            "referenceCoordinates": {"lat": target_lat, "lon": target_lon},
                            "observations": {},
                        }

                    # Find nearest cell
                    if lats.ndim == 1 and lons.ndim == 1:
                        lat_idx = int(np.argmin(np.abs(lats - target_lat)))
                        lon_idx = int(np.argmin(np.abs(lons - target_lon)))
                        val = float(sm[lat_idx, lon_idx])
                        pixel_index = (lat_idx, lon_idx)
                        actual_lat = float(lats[lat_idx])
                        actual_lon = float(lons[lon_idx])
                    else:
                        dist_sq = (lats - target_lat) ** 2 + (lons - target_lon) ** 2
                        min_idx = np.unravel_index(np.argmin(dist_sq), dist_sq.shape)
                        val = float(sm[min_idx])
                        pixel_index = min_idx
                        actual_lat = float(lats[min_idx])
                        actual_lon = float(lons[min_idx])

                    raw_flag = _read_optional(qf_dset, pixel_index, float(qf_dset.attrs.get("_FillValue", 65534)))
                    raw_flag_dca = _read_optional(qf_dca_dset, pixel_index, float(qf_dca_dset.attrs.get("_FillValue", 65534)) if qf_dca_dset is not None else None)
                    flag = int(raw_flag) if raw_flag is not None else 65534
                    dca_flag = int(raw_flag_dca) if raw_flag_dca is not None else None
                    raw_surf = _read_optional(sf_dset, pixel_index, float(sf_dset.attrs.get("_FillValue", 65534)) if sf_dset is not None else None)
                    surf = int(raw_surf) if raw_surf is not None else None
                    surf_temp = _read_optional(st_dset, pixel_index, float(st_dset.attrs.get("_FillValue", -9999.0)) if st_dset is not None else None)
                    ft_frac = _read_optional(ft_dset, pixel_index, float(ft_dset.attrs.get("_FillValue", -9999.0)) if ft_dset is not None else None)
                    dca_fill = float(dca_dset.attrs.get("_FillValue", fill_val)) if dca_dset is not None else fill_val
                    dca_value = _read_optional(dca_dset, pixel_index, dca_fill)
                    bulk_density = _read_optional(bd_dset, pixel_index, float(bd_dset.attrs.get("_FillValue", -9999.0)) if bd_dset is not None else None)
                    clay_fraction = _read_optional(clay_dset, pixel_index, float(clay_dset.attrs.get("_FillValue", -9999.0)) if clay_dset is not None else None)
                    static_water_fraction = _read_optional(static_water_dset, pixel_index, float(static_water_dset.attrs.get("_FillValue", -9999.0)) if static_water_dset is not None else None)
                    radar_water_fraction = _read_optional(radar_water_dset, pixel_index, float(radar_water_dset.attrs.get("_FillValue", -9999.0)) if radar_water_dset is not None else None)
                    acquisition_time_utc = _read_time(time_dset, pixel_index) if time_dset is not None else None

                    # Verify spatial containment within expected district bounds
                    in_district_bbox = (
                        bbox["minLat"] <= actual_lat <= bbox["maxLat"]
                        and bbox["minLon"] <= actual_lon <= bbox["maxLon"]
                    )
                    geodesic_distance_km = haversine_distance_km(target_lat, target_lon, actual_lat, actual_lon)

                    # NASA SMAP retrieval_qual_flag bitmask interpretation:
                    # Bit 0 (1): Retrieval recommended (0 = recommended, 1 = not recommended)
                    # Bit 1 (2): Retrieval attempted (0 = attempted, 1 = not attempted)
                    # Bit 2 (4): Retrieval success (0 = success, 1 = not successful)
                    # Bit 3 (8): Freeze/Thaw retrieval success (8 = FT success)
                    bit0_rec = raw_flag is not None and (flag & 1) == 0
                    bit1_att = raw_flag is not None and (flag & 2) == 0
                    bit2_suc = raw_flag is not None and (flag & 4) == 0
                    bit3_ft_unsuccessful = raw_flag is None or (flag & 8) != 0
                    is_fill = (val <= fill_val) or np.isnan(val)
                    is_in_physical_range = (valid_min <= val <= valid_max) if not is_fill else False
                    is_recommended = bit0_rec and bit1_att and bit2_suc and is_in_physical_range and in_district_bbox

                    obs_result = {
                        "orbit": orbit,
                        "raw_value": val if not np.isnan(val) else None,
                        "is_fill": bool(is_fill),
                        "soil_moisture": float(round(val, 4)) if is_in_physical_range else None,
                        "soil_moisture_dca": float(round(dca_value, 4)) if dca_value is not None and valid_min <= dca_value <= valid_max else None,
                        "retrieval_qual_flag_dca": dca_flag,
                        "acquisition_time_utc": acquisition_time_utc,
                        "unit": "m^3/m^3",
                        "retrieval_qual_flag": flag,
                        "qa_breakdown": {
                            "bit0_recommended": bool(bit0_rec),
                            "bit1_attempted": bool(bit1_att),
                            "bit2_successful": bool(bit2_suc),
                            "bit3_freeze_thaw_unsuccessful": bool(bit3_ft_unsuccessful),
                            "raw_flag_value": flag,
                        },
                        "surface_flag": surf,
                        "surface_diagnostics": {
                            "surface_flag_raw": surf,
                            "surface_flag_binary": bin(surf) if surf is not None else None,
                            "surface_temperature_k": round(surf_temp, 2) if surf_temp is not None else None,
                            "surface_temperature_c": round(surf_temp - 273.15, 2) if surf_temp is not None else None,
                            "freeze_thaw_fraction": ft_frac,
                            "bulk_density": bulk_density,
                            "clay_fraction": clay_fraction,
                            "static_water_body_fraction": static_water_fraction,
                            "radar_water_body_fraction": radar_water_fraction,
                        },
                        "is_recommended": bool(is_recommended),
                        "spatial_verification": {
                            "in_district_bbox": bool(in_district_bbox),
                            "reference_coords": {"lat": target_lat, "lon": target_lon},
                            "pixel_coords": {"lat": actual_lat, "lon": actual_lon},
                            "geodesic_distance_km": round(geodesic_distance_km, 2),
                        },
                    }
                    result["districts"][dist_code]["observations"][orbit] = obs_result

        return result
    except Exception as ex:
        return {"success": False, "error": str(ex)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python smap_parser.py <path_to_hdf5_file> [district_code]"}))
        sys.exit(1)

    file_path = sys.argv[1]
    dist_code = sys.argv[2] if len(sys.argv) > 2 else None
    res = inspect_and_parse_smap_hdf5(file_path, dist_code)
    print(json.dumps(res, indent=2))
