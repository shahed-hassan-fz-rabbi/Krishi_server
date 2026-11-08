"""
Scientific HDF5 Parser and Validator for NASA SMAP SPL3SMP_E Version 6.
Enforces strict district separation and verifies pixel coordinates against reference points.
"""

import sys
import json
import os
import math
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

            for group_name in ["Soil_Moisture_Retrieval_Data_AM", "Soil_Moisture_Retrieval_Data_PM"]:
                if group_name not in h5:
                    continue

                grp = h5[group_name]
                orbit = "AM" if "AM" in group_name else "PM"

                lat_dset = grp.get("latitude")
                lon_dset = grp.get("longitude")
                sm_dset = grp.get("soil_moisture")
                qf_dset = grp.get("retrieval_qual_flag")
                sf_dset = grp.get("surface_flag")
                st_dset = grp.get("surface_temperature")
                ft_dset = grp.get("freeze_thaw_fraction")

                if lat_dset is None or lon_dset is None or sm_dset is None:
                    continue

                lats = lat_dset[:]
                lons = lon_dset[:]
                sm = sm_dset[:]
                qf = qf_dset[:] if qf_dset is not None else None
                sf = sf_dset[:] if sf_dset is not None else None
                st = st_dset[:] if st_dset is not None else None
                ft = ft_dset[:] if ft_dset is not None else None

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
                        flag = int(qf[lat_idx, lon_idx]) if qf is not None else 0
                        surf = int(sf[lat_idx, lon_idx]) if sf is not None else 0
                        surf_temp = float(st[lat_idx, lon_idx]) if st is not None else None
                        ft_frac = float(ft[lat_idx, lon_idx]) if ft is not None else None
                        actual_lat = float(lats[lat_idx])
                        actual_lon = float(lons[lon_idx])
                    else:
                        dist_sq = (lats - target_lat) ** 2 + (lons - target_lon) ** 2
                        min_idx = np.unravel_index(np.argmin(dist_sq), dist_sq.shape)
                        val = float(sm[min_idx])
                        flag = int(qf[min_idx]) if qf is not None else 0
                        surf = int(sf[min_idx]) if sf is not None else 0
                        surf_temp = float(st[min_idx]) if st is not None else None
                        ft_frac = float(ft[min_idx]) if ft is not None else None
                        actual_lat = float(lats[min_idx])
                        actual_lon = float(lons[min_idx])

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
                    bit0_rec = (flag & 1) == 0
                    bit1_att = (flag & 2) == 0
                    bit2_suc = (flag & 4) == 0
                    is_fill = (val <= fill_val) or np.isnan(val)
                    is_in_physical_range = (valid_min <= val <= valid_max) if not is_fill else False
                    is_recommended = bit0_rec and bit2_suc and is_in_physical_range and in_district_bbox

                    obs_result = {
                        "orbit": orbit,
                        "raw_value": val if not np.isnan(val) else None,
                        "is_fill": bool(is_fill),
                        "soil_moisture": float(round(val, 4)) if is_in_physical_range else None,
                        "unit": "m^3/m^3",
                        "retrieval_qual_flag": flag,
                        "qa_breakdown": {
                            "bit0_recommended": bool(bit0_rec),
                            "bit1_attempted": bool(bit1_att),
                            "bit2_successful": bool(bit2_suc),
                            "raw_flag_value": flag,
                        },
                        "surface_flag": surf,
                        "surface_diagnostics": {
                            "surface_flag_raw": surf,
                            "surface_flag_binary": bin(surf),
                            "surface_temperature_k": round(surf_temp, 2) if surf_temp is not None else None,
                            "surface_temperature_c": round(surf_temp - 273.15, 2) if surf_temp is not None else None,
                            "freeze_thaw_fraction": ft_frac,
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
