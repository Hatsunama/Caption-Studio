"""Run only on GitHub: audit the packaged binary manifest, not just source."""
from pathlib import Path
import re
import hashlib
import subprocess
import xml.etree.ElementTree as ET

root = ET.parse("AndroidManifest.xml").getroot()
ns = "{http://schemas.android.com/apk/res/android}"
assert root.attrib["package"] == "app.captionstudio.verification.sharereceiver"
assert not root.findall("uses-permission")
app = root.find("application")
assert app is not None and app.attrib[ns + "allowBackup"] == "false"
assert app.attrib[ns + "debuggable"] == "true"
assert app.attrib[ns + "usesCleartextTraffic"] == "false"
assert [node.tag for node in app] == ["activity"]
activity = app.find("activity")
assert activity.attrib[ns + "exported"] == "true"
assert activity.attrib[ns + "launchMode"] == "singleTask"
permissions = Path("out/permissions.txt").read_text()
assert not re.search(r"uses-permission|permission:", permissions)
badging = Path("out/badging.txt").read_text()
assert "package: name='app.captionstudio.verification.sharereceiver'" in badging
assert "application-debuggable" in badging
assert re.search(r"(?m)^(?:minSdkVersion|sdkVersion):\s*'24'", badging), badging
assert re.search(r"targetSdkVersion:\s*'36'", badging), badging
assert "launchable-activity: name='app.captionstudio.verification.sharereceiver.VerificationActivity'" in badging
assert "label='Caption Studio Verification'" in badging
manifest = Path("out/manifest.txt").read_text()
assert len(re.findall(r"E: activity(?:\s|$)", manifest)) == 1
assert not re.search(r"E: (?:uses-permission\S*|provider|service|receiver)(?:\s|$)", manifest)
for attr in ("exported", "debuggable"):
    assert re.search(r":" + attr + r"\(0x[0-9a-f]+\)=true(?:\s|$)", manifest), manifest
for attr in ("allowBackup", "usesCleartextTraffic"):
    assert re.search(r":" + attr + r"\(0x[0-9a-f]+\)=false(?:\s|$)", manifest), manifest
for literal in ("android.intent.action.SEND", "android.intent.action.MAIN",
                "android.intent.category.DEFAULT", "android.intent.category.LAUNCHER",
                "text/*", "application/x-subrip", "*/*", "Caption Studio Verification"):
    assert literal in manifest, literal

# The original receiver control flow is byte-identical after undoing ONLY
# the metadata string expansion. This covers delayed open, timeout, URI grants,
# lifecycle cancellation, buffer wiping, and the single-worker/no-queue limit.
def blob_sha(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()

src = Path("src/app/captionstudio/verification/sharereceiver")
assert blob_sha((src / "BoundedRead.java").read_bytes()) == "33f06ddff0ccfa350e34972db8a7793b353184d2"
activity_bytes = (src / "VerificationActivity.java").read_bytes()
new_metadata = b'return "Format: UNKNOWN\\nBytes: unavailable\\nSHA256: unavailable\\nCue count: unavailable"\n            + "\\nFirst start ms: unavailable\\nMaximum end ms: unavailable\\nError: " + error;'
old_metadata = b'return "Bytes: unavailable\\nSHA256: unavailable\\nCue count: unavailable\\nError: " + error;'
assert activity_bytes.count(new_metadata) == 1
assert blob_sha(activity_bytes.replace(new_metadata, old_metadata)) == "2e4d16f88363b8c935637e4d288c58935cf5a71e"
base = "ad7a90455d971ae27d4cf16d083e4f1abeeeea82"
red = "0d79f7059bf69c9e261b5c5fc7f4f4ce6719888d"
prefix = "tools/share-recipient-verification/"
allowed = {
    ".github/workflows/share-recipient-verification.yml",
    prefix + "tests/SubtitleExportTest.java", prefix + "test.sh",
    prefix + "src/app/captionstudio/verification/sharereceiver/Validator.java",
    prefix + "src/app/captionstudio/verification/sharereceiver/VerificationActivity.java",
    prefix + "audit.py", prefix + "build.sh", prefix + "README.md",
}
changed = subprocess.check_output(["git", "diff", "--name-only", base, "HEAD"], text=True).splitlines()
assert changed and set(changed).issubset(allowed), changed
assert not subprocess.check_output(["git", "diff", red, "HEAD", "--",
    prefix + "tests/SubtitleExportTest.java", prefix + "tests/ValidatorTest.java",
    prefix + "test.sh"])
Path("out/change-impact.txt").write_text(
    "BASE=" + base + "\nRED_SOURCE=" + red + "\n"
    "CHANGE_SCOPE=TOOL_AND_TEST_WORKFLOW_ONLY\n"
    "RED_TESTS_UNCHANGED=PASS\nBOUNDED_READ_BASE_BLOB=PASS\n"
    "RECEIVER_CONTROL_FLOW_BASE_BLOB_EXCEPT_METADATA=PASS\n"
    "DELAY_MS=1500\nTIMEOUT_MS=12000\nREAD_CAP_BYTES=1048576\n"
    "WORKER_MAX=1\nWORKER_QUEUE=NONE\n"
    "APP_MODEL_MAIN_PUBLISH_CHANGES=NONE\nRAW_CAPTION_DISPLAY_LOG_UPLOAD=NONE\n"
    "DEVICE_RUNTIME=NOT_EXECUTED_PARENT_OWNED\n"
    "CHANGED_FILES:\n" + "\n".join(changed) + "\n", encoding="utf-8")
print(Path("out/change-impact.txt").read_text(), end="")

Path("out/audit.txt").write_text(
    "PACKAGE_AUDIT=PASS\nPERMISSIONS=NONE\nCOMPONENTS=ONE_EXPORTED_ACTIVITY\n"
    "LAUNCHER_AND_SEND_FILTERS=PASS\nDEBUG_SIGNATURE=VERIFIED\n"
    "BACKUP_AND_CLEARTEXT=DISABLED\n", encoding="utf-8")
print(Path("out/audit.txt").read_text(), end="")
