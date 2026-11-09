"""Read target grid cells from one NASA IMERG HDF5 granule; emit JSON only."""
import datetime as dt
import json
import math
import re
import sys

import h5py
import numpy as np

EPOCH = dt.datetime(1980, 1, 6, tzinfo=dt.timezone.utc)
FILL_FLOAT = -9999.9
FILL_INT = -9999
TARGETS = {
    "cumilla": (23.46186, 91.18503),
    "chattogram": (22.3384, 91.8317),
}


def scalar(dataset, index, fill_value):
    value = float(dataset[index])
    if not math.isfinite(value) or math.isclose(value, fill_value, rel_tol=0, abs_tol=0.001):
        return None
    return value


def main(path):
    with h5py.File(path, "r") as f:
        grid = f["Grid"]
        start_seconds = int(grid["time"][0])
        bounds_seconds = [int(x) for x in grid["time_bnds"][0]]
        start = EPOCH + dt.timedelta(seconds=start_seconds)
        end = EPOCH + dt.timedelta(seconds=bounds_seconds[1])
        if bounds_seconds[0] != start_seconds or (end - start).total_seconds() != 1800:
            raise ValueError("Expected one 30-minute IMERG time interval")
        if grid["precipitation"].attrs.get("units", b"").decode() != "mm/hr":
            raise ValueError("Unexpected precipitation unit")
        if grid["precipitation"].shape[0] != 1:
            raise ValueError("Expected exactly one half-hour time slice")

        latitudes = grid["lat"][:]
        longitudes = grid["lon"][:]
        observations = []
        for district, (target_lat, target_lon) in TARGETS.items():
            lat_index = int(np.abs(latitudes - target_lat).argmin())
            lon_index = int(np.abs(longitudes - target_lon).argmin())
            cell = (0, lon_index, lat_index)
            rate = scalar(grid["precipitation"], cell, FILL_FLOAT)
            quality = scalar(grid["precipitationQualityIndex"], cell, FILL_FLOAT)
            error = scalar(grid["randomError"], cell, FILL_FLOAT)
            probability = scalar(grid["probabilityLiquidPrecipitation"], cell, FILL_INT)
            if rate is not None and rate < 0:
                raise ValueError("Negative precipitation rate outside fill value")

            observations.append({
                "districtCode": district,
                "intervalStartUtc": start.isoformat().replace("+00:00", "Z"),
                "intervalEndUtc": end.isoformat().replace("+00:00", "Z"),
                "dateLabel": (start + dt.timedelta(hours=6)).date().isoformat(),
                "precipitationRateMmHr": rate,
                "precipitationMm": None if rate is None else rate * 0.5,
                "randomErrorMmHr": None if error == FILL_FLOAT else error,
                "precipitationQualityIndex": None if quality == FILL_FLOAT else quality,
                "probabilityLiquidPrecipitationPercent": None if probability == FILL_INT else probability,
                "sourceQuality": "missing_fill" if rate is None else "valid",
                "latitude": float(latitudes[lat_index]),
                "longitude": float(longitudes[lon_index]),
                "targetReferenceLat": target_lat,
                "targetReferenceLon": target_lon,
            })

        header = f.attrs.get("FileHeader", b"")
        if isinstance(header, bytes):
            header = header.decode("utf-8", errors="replace")
        version = re.search(r"AlgorithmVersion=([^;\n]+)", header)
        print(json.dumps({
            "fileName": path.replace("\\", "/").split("/")[-1],
            "algorithmVersion": version.group(1).strip() if version else None,
            "timeStartUtc": start.isoformat().replace("+00:00", "Z"),
            "timeEndUtc": end.isoformat().replace("+00:00", "Z"),
            "observations": observations,
        }, allow_nan=False))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python gpm_parser.py <HDF5 file>")
    main(sys.argv[1])
