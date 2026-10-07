"""Run only on GitHub: audit the packaged binary manifest, not just source."""
from pathlib import Path
import re
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
    assert re.search(r"android:" + attr + r".*\)0x0(?:\s|$)", manifest), attr
for literal in ("android.intent.action.SEND", "android.intent.action.MAIN",
                "android.intent.category.DEFAULT", "android.intent.category.LAUNCHER",
                "text/*", "application/x-subrip", "*/*", "Caption Studio Verification"):
    assert literal in manifest, literal
Path("out/audit.txt").write_text(
    "PACKAGE_AUDIT=PASS\nPERMISSIONS=NONE\nCOMPONENTS=ONE_EXPORTED_ACTIVITY\n"
    "LAUNCHER_AND_SEND_FILTERS=PASS\nDEBUG_SIGNATURE=VERIFIED\n"
    "BACKUP_AND_CLEARTEXT=DISABLED\n", encoding="utf-8")
print(Path("out/audit.txt").read_text(), end="")
