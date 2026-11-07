"""Lightweight ZIP fixtures: marker packaging proof, not render proof."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/verify-private-frame-pts-apk.py"
SPEC = importlib.util.spec_from_file_location("private_pts_apk", SCRIPT)
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)
HEADER = b"dex\n035\x00"
MARKERS = b"CS_FRAME_PTS\x00actualPresentationTimeUs="


class MarkerPackagingTests(unittest.TestCase):
    def run_fixture(self, entries, passes):
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / "fixture.apk"
            with zipfile.ZipFile(apk, "w", zipfile.ZIP_DEFLATED) as archive:
                for name, data in entries.items():
                    archive.writestr(name, data)
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), str(apk)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0 if passes else 1, result.stderr)
            self.assertNotIn(str(apk), result.stdout + result.stderr)

    def test_native_markers_pass(self):
        self.run_fixture({"classes.dex": HEADER + MARKERS}, True)

    def test_js_only_fails(self):
        self.run_fixture({"classes.dex": HEADER, "assets/index.android.bundle": MARKERS}, False)

    def test_either_missing_marker_fails(self):
        for marker in VERIFIER.MARKERS:
            with self.subTest(marker=marker):
                self.run_fixture({"classes.dex": HEADER + marker}, False)

    def test_multidex_and_chunk_boundary_pass(self):
        self.run_fixture({"classes.dex": HEADER + b"CS_FRAME_PTS",
                          "classes12.dex": HEADER + b"x" * (VERIFIER.CHUNK_SIZE - 4)
                          + b"actualPresentationTimeUs="}, True)

    def test_nested_dex_and_invalid_header_fail(self):
        self.run_fixture({"assets/classes.dex": HEADER + MARKERS}, False)
        self.run_fixture({"classes.dex": MARKERS}, False)

    def test_bad_zip_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / "bad.apk"
            apk.write_bytes(b"not a zip")
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), str(apk)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr.strip(), "FAIL: private PTS DEX marker packaging check")

    def test_dex_crc_failure_after_markers_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / "corrupt.apk"
            with zipfile.ZipFile(apk, "w", zipfile.ZIP_STORED) as archive:
                archive.writestr("classes.dex", HEADER + MARKERS + b"trailer")
            data = apk.read_bytes()
            apk.write_bytes(data.replace(b"trailer", b"TRAILER", 1))
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), str(apk)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr.strip(), "FAIL: private PTS DEX marker packaging check")


if __name__ == "__main__":
    unittest.main()
