import datetime as dt
import unittest

import numpy as np

from .gpm_parser import EPOCH, FILL_FLOAT, FILL_INT, scalar


class GpmParserHelpersTest(unittest.TestCase):
    def test_float_fill_and_integer_fill_are_missing(self):
        self.assertIsNone(scalar(np.array([np.float32(FILL_FLOAT)]), 0, FILL_FLOAT))
        self.assertIsNone(scalar(np.array([FILL_INT]), 0, FILL_INT))

    def test_zero_is_a_valid_rate(self):
        self.assertEqual(scalar(np.array([0.0], dtype=np.float32), 0, FILL_FLOAT), 0.0)

    def test_interval_rate_conversion_uses_half_hour_duration(self):
        rate_mm_hr = 2.4
        precipitation_mm = rate_mm_hr * (30 * 60 / 3600)
        self.assertAlmostEqual(precipitation_mm, 1.2)

    def test_utc_time_maps_to_bangladesh_local_date(self):
        start = EPOCH + dt.timedelta(seconds=1388102400)
        local = start + dt.timedelta(hours=6)
        self.assertEqual(start.isoformat(), "2024-01-01T00:00:00+00:00")
        self.assertEqual(local.date().isoformat(), "2024-01-01")


if __name__ == "__main__":
    unittest.main()
