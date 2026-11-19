"""build_ebirdst.py: the raster sampling and the summary, on a small made-up GeoTIFF in the eBird sinusoidal projection."""
import os, sys, tempfile, unittest
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import build_ebirdst as B

SIN = "+proj=sinu +lon_0=0 +x_0=0 +y_0=0 +R=6371007.181 +units=m +no_defs"


class T(unittest.TestCase):
    def make(self, path, value_fn):
        import rasterio
        from rasterio.transform import from_origin
        from rasterio.warp import transform
        # 3 km cells around Maryland, 52 weeks
        x0, y0 = transform("EPSG:4326", SIN, [-90.0], [41.0]); x0, y0 = x0[0], y0[0]
        h, w = 400, 800
        data = np.zeros((52, h, w), dtype="float32")
        tr = from_origin(x0, y0, 3000, 3000)
        for k in range(52):
            data[k] = value_fn(k, h, w)
        with rasterio.open(path, "w", driver="GTiff", height=h, width=w, count=52, dtype="float32", crs=SIN, transform=tr, nodata=-1) as d:
            d.write(data)

    def test_sampling_and_summary(self):
        lons, lats = B.grid()
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, "a.tif")
            # week 0 = 1 everywhere, week 10 = 5 everywhere, a nodata strip, everything else 0
            def fn(k, h, w):
                a = np.zeros((h, w), dtype="float32")
                if k == 0: a[:] = 1
                if k == 10: a[:] = 5
                if k == 20: a[:, :50] = -1   # nodata
                return a
            self.make(p, fn)
            arr = B.sample_weekly(p, lons, lats)
        self.assertEqual(arr.shape, (52, len(lats), len(lons)))
        self.assertTrue(np.allclose(arr[0], 1) and np.allclose(arr[10], 5))
        self.assertTrue(np.all(arr[20] == 0))       # nodata becomes 0
        ints, ref = B.summarize(arr + arr)           # two identical species added together
        self.assertEqual(int(ints[10, 0, 0]), 10000)
        self.assertEqual(ref["weeks"], 52)
        self.assertEqual(ref["cells"], len(lats) * len(lons))
        self.assertTrue(ref["sd"] > 0)

    def test_outside_raster_is_zero(self):
        lons, lats = B.grid()
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, "b.tif")
            self.make(p, lambda k, h, w: np.ones((h, w), dtype="float32"))
            # shrink: pretend the raster covers only part of the box by cropping the grid to include far east/south
            arr = B.sample_weekly(p, lons + [-40.0], lats)   # a column far outside the raster
        self.assertTrue(np.all(arr[:, :, -1] == 0))


if __name__ == "__main__":
    unittest.main()
