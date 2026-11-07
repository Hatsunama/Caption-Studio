"""PRIVATE: DEX marker packaging proof only, never render/runtime proof."""
import re
import sys
import zipfile

MARKERS = (b"CS_FRAME_PTS", b"actualPresentationTimeUs=")
CHUNK_SIZE = 64 * 1024


def verify(apk):
    found = set()
    with zipfile.ZipFile(apk) as archive:
        for entry in archive.infolist():
            # Android loads root classes*.dex, not assets or nested lookalikes.
            if not re.fullmatch(r"classes(?:[2-9]|[1-9][0-9]+)?\.dex", entry.filename):
                continue
            with archive.open(entry) as dex:
                header = dex.read(8)
                if not re.fullmatch(rb"dex\n[0-9]{3}\x00", header):
                    raise ValueError("Invalid DEX header")
                tail = header
                while True:
                    chunk = dex.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    window = tail + chunk
                    found.update(marker for marker in MARKERS if marker in window)
                    tail = window[-(max(map(len, MARKERS)) - 1):]
                # Always finish each DEX stream so zipfile checks its CRC.
    if found != set(MARKERS):
        raise ValueError("Required private PTS DEX markers missing")


def main():
    if len(sys.argv) != 2:
        print("Usage: verify-private-frame-pts-apk.py APK", file=sys.stderr)
        return 1
    try:
        verify(sys.argv[1])
    except (OSError, ValueError, RuntimeError, EOFError, zipfile.BadZipFile, NotImplementedError):
        # No paths, entry names, exception text, or media/user data in logs.
        print("FAIL: private PTS DEX marker packaging check", file=sys.stderr)
        return 1
    print("PASS: private PTS DEX markers packaged (not render proof)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
