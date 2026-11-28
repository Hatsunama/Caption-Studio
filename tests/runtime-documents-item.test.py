import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1]/'scripts/verify-android-native-compatibility-runtime.py'
spec = importlib.util.spec_from_file_location('documents_item_runtime', path)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
PACKAGE = 'com.android.documentsui'
FIXTURE = '''<hierarchy><node package="com.android.documentsui" class="android.support.v7.widget.RecyclerView" resource-id="com.android.documentsui:id/dir_list" enabled="true" bounds="[0,140][320,640]">
<node class="android.widget.RelativeLayout" focusable="true" enabled="true" clickable="false" bounds="[14,156][156,349]">
<node text="ci-tiny.mp4" class="android.widget.TextView" enabled="true" clickable="false" bounds="[66,302][142,324]" />
</node></node></hierarchy>'''

class DocumentsItem(unittest.TestCase):
    def test_exact_enabled_fixture_uses_recycler_delegation_without_faking_clickable(self):
        item = runtime.find_control(FIXTURE, 'ci-tiny.mp4', PACKAGE)
        self.assertFalse(item['clickable'])
        self.assertTrue(item.get('delegatedClick', False))
        self.assertTrue(runtime.control_can_be_tapped(item))

    def test_delegation_is_not_allowed_for_unknown_package_name_or_container(self):
        for xml, label, package in (
            (FIXTURE, 'ci-tiny.mp4', None),
            (FIXTURE.replace('ci-tiny.mp4', 'another.mp4'), 'another.mp4', PACKAGE),
            (FIXTURE.replace('RecyclerView', 'LinearLayout'), 'ci-tiny.mp4', PACKAGE),
            (FIXTURE.replace('com.android.documentsui', 'other.package'), 'ci-tiny.mp4', 'other.package')):
            with self.subTest(label=label, package=package):
                self.assertFalse(runtime.control_can_be_tapped(runtime.find_control(xml, label, package)))

    def test_disabled_item_and_ambiguous_fixture_never_tap(self):
        disabled = FIXTURE.replace('enabled="true"', 'enabled="false"', 1)
        self.assertFalse(runtime.control_can_be_tapped(runtime.find_control(disabled, 'ci-tiny.mp4', PACKAGE)))
        duplicate = FIXTURE.replace('</node></node></hierarchy>', '<node text="ci-tiny.mp4" bounds="[10,20][40,60]" /></node></node></hierarchy>')
        with self.assertRaises(ValueError):
            runtime.find_control(duplicate, 'ci-tiny.mp4', PACKAGE)

if __name__ == '__main__':
    unittest.main()
