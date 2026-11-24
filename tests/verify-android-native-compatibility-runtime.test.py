import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent/'scripts/verify-android-native-compatibility-runtime.py'


class RuntimeHarness(unittest.TestCase):
    def test_runtime_bootstraps_pinned_node_and_verified_hardened_java_before_tools(self):
        root = HERE.parent
        workflow = (root/'.github/workflows/verify-final-android-runtime.yml').read_text()
        node_setup = 'uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1'
        self.assertIn(node_setup, workflow, 'Runtime tools require the project pinned Node bootstrap')
        setup = workflow.index(node_setup)
        self.assertIn('node-version: 22.23.4', workflow[setup:setup+180])
        verified = workflow.index('node scripts/build-toolchain/verified-java-download.mjs --install "$RUNNER_TOOL_CACHE"')
        hardened = workflow.index('node scripts/harden-java-truststores.mjs --ci')
        self.assertIn('--receipt "$GITHUB_WORKSPACE/evidence/final-runtime/verified-java.json"', workflow)
        self.assertLess(setup, verified)
        self.assertLess(verified, hardened)
        self.assertLess(hardened, workflow.index('sdkmanager "build-tools;36.0.0"'))
        self.assertLess(hardened, workflow.index('uses: reactivecircus/android-emulator-runner@'))
        self.assertNotIn('npm ci', workflow)
        wrapper = (root/'scripts/verify-android-native-compatibility-runtime.sh').read_text()
        self.assertIn('export JAVA_HOME="${JAVA_HOME_17_X64:?JDK17 required}"', wrapper)

    def test_runtime_build_tools_match_approved_signing_contract_and_are_installed(self):
        root = HERE.parent
        signing = root/'scripts/local-signing/sign-validation.mjs'
        self.assertIn('Build tools 36.0.0 required', signing.read_text())
        wrapper = (root/'scripts/verify-android-native-compatibility-runtime.sh').read_text()
        workflow = (root/'.github/workflows/verify-final-android-runtime.yml').read_text()
        self.assertIn('--build-tools "$ANDROID_HOME/build-tools/36.0.0"', wrapper)
        self.assertNotIn('37.0.0', wrapper)
        self.assertRegex(workflow, r'sdkmanager[^\n]*[\"\']build-tools;36\.0\.0[\"\']')
        self.assertLess(workflow.index('build-tools;36.0.0'), workflow.index('uses: reactivecircus/android-emulator-runner@'))

    def setUp(self):
        spec = importlib.util.spec_from_file_location('runtime', SCRIPT)
        self.m = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.m)

    def test_owner_main_context_is_mandatory(self):
        env = dict(GITHUB_ACTIONS='true', GITHUB_EVENT_NAME='workflow_dispatch',
                   GITHUB_REPOSITORY='Hatsunama/Caption-Studio', GITHUB_REPOSITORY_OWNER='Hatsunama',
                   GITHUB_ACTOR='Hatsunama', GITHUB_TRIGGERING_ACTOR='Hatsunama', GITHUB_REF='refs/heads/main',
                   GITHUB_WORKFLOW_REF='Hatsunama/Caption-Studio/.github/workflows/verify-final-android-runtime.yml@refs/heads/main')
        self.m.assert_context(env)
        for k in env:
            with self.subTest(k=k), self.assertRaises(ValueError): self.m.assert_context({**env, k: 'other'})

    def test_draft_asset_ids_names_and_hashes_fail_closed(self):
        request = {'release_id': '123', 'expected_source_commit': 'a'*40}
        assets = []
        for i, (role, name) in enumerate(self.m.ASSETS.items(), 1):
            request[role+'_asset_id'] = str(i); request[role+'_sha256'] = 'b'*64
            assets.append(dict(id=i, name=name, state='uploaded', size=12, digest='sha256:'+'b'*64))
        release = dict(id=123, draft=True, target_commitish='a'*40, author={'login': 'Hatsunama'}, assets=assets)
        self.m.validate_assets(request, release)
        for mutate in (lambda r: r.update(draft=False), lambda r: r.update(id=9),
                       lambda r: r.update(target_commitish='main'), lambda r: r['assets'][0].update(name='wrong.apk'),
                       lambda r: r['assets'][0].update(digest='sha256:'+'c'*64)):
            value = json.loads(json.dumps(release)); mutate(value)
            with self.assertRaises(ValueError): self.m.validate_assets(request, value)
        for value in ('../123', '0123', '1;echo BAD'):
            with self.assertRaises(ValueError): self.m.validate_assets({**request, 'release_id': value}, release)

    def test_disabled_parent_not_enabled_label_and_ambiguous_ui(self):
        for enabled in (False, True):
            xml = f'<hierarchy><node package="com.xmilo_at_your_side.caption_studio" enabled="{str(enabled).lower()}" clickable="{str(enabled).lower()}" bounds="[1,2][30,40]"><node text="Dual subtitles" enabled="true" bounds="[1,2][30,40]" /></node></hierarchy>'
            node = self.m.find_control(xml, 'Dual subtitles', self.m.PACKAGE)
            self.assertEqual(node['enabled'], enabled)
        with self.assertRaises(ValueError):
            self.m.find_control('<hierarchy><node text="Dual subtitles"/><node text="Dual subtitles"/></hierarchy>', 'Dual subtitles', self.m.PACKAGE)

    def test_derived_apk_must_preserve_all_aab_native_dex_and_asset_bytes(self):
        with tempfile.TemporaryDirectory(dir=HERE) as temp:
            root = Path(temp); aab = root/'a.aab'; apk = root/'a.apk'
            with zipfile.ZipFile(aab, 'w') as z:
                z.writestr('base/lib/x86/libcore.so', b'ELF'); z.writestr('base/dex/classes.dex', b'DEX'); z.writestr('base/assets/font', b'font')
            def make(mutation=False):
                with zipfile.ZipFile(apk, 'w') as z:
                    z.writestr('lib/x86/libcore.so', b'changed' if mutation else b'ELF')
                    z.writestr('classes.dex', b'DEX'); z.writestr('assets/font', b'font')
            make(); self.m.assert_derived_payload(aab, apk)
            make(True)
            with self.assertRaises(ValueError): self.m.assert_derived_payload(aab, apk)

    def test_actual_file_hashes_source_tree_identity_and_certificate_checks(self):
        with tempfile.TemporaryDirectory(dir=HERE) as temp:
            root = Path(temp); (root/'config').mkdir()
            roles = {'apk': 'a'*64, 'aab': 'b'*64}
            (root/'config/local-signing-contract.json').write_text(json.dumps({'roles': roles}))
            (root/'config/product-contract.json').write_text(json.dumps({'android': {'release': {'signingCertificateSha256': roles['apk']}}}))
            for role in ('solana', 'play', 'aab'):
                with zipfile.ZipFile(root/self.m.ASSETS[role], 'w') as z:
                    z.writestr('base/assets/data' if role == 'aab' else 'assets/data', b'exact asset')
            receipt = dict(schemaVersion=1, repository=self.m.REPO, sourceCommit='c'*40, sourceTree='d'*40,
                           package=self.m.PACKAGE, version='1.4.149', versionCode=161, certificates=roles,
                           payloads={k: {'sha256': self.m.sha(root/self.m.ASSETS[r])} for r, k in (('solana', 'apk'), ('aab', 'aab'))})
            request = dict(expected_source_commit='c'*40, source_tree='d'*40)
            def save(value):
                (root/self.m.ASSETS['receipt']).write_text(json.dumps(value))
                for role, name in self.m.ASSETS.items(): request[role+'_sha256'] = self.m.sha(root/name)
                (root/'request.json').write_text(json.dumps(request))
            def execute(args):
                if 'badging' in args:
                    return f"package: name='{self.m.PACKAGE}' versionCode='161' versionName='1.4.149'\nsdkVersion:'24'\ntargetSdkVersion:'36'"
                if '--print-certs' in args:
                    role = 'apk' if str(args[-1]).endswith(self.m.ASSETS['solana']) else 'aab'
                    return f'Signer #1 certificate SHA-256 digest: {roles[role]}\nVerified using v2 scheme (APK Signature Scheme v2): true\n'
                return 'VERIFIED'
            save(receipt)
            with patch.object(self.m, 'ROOT', root), patch.object(self.m, 'run', side_effect=execute):
                self.m.verify_files(root, root)
                for field in ('sourceTree', 'sourceCommit', 'package'):
                    bad = dict(receipt); bad[field] = 'wrong'; save(bad)
                    with self.assertRaises(ValueError): self.m.verify_files(root, root)
                save(receipt)
                with patch.object(self.m, 'run', return_value='wrong binary identity'):
                    with self.assertRaises(ValueError): self.m.verify_files(root, root)
                def wrong_certificate(args):
                    return execute(args).replace(roles['apk'], '0'*64) if '--print-certs' in args else execute(args)
                with patch.object(self.m, 'run', side_effect=wrong_certificate):
                    with self.assertRaisesRegex(ValueError, 'signature'): self.m.verify_files(root, root)
                (root/self.m.ASSETS['play']).write_bytes(b'changed after download')
                with self.assertRaises(ValueError): self.m.verify_files(root, root)


if __name__ == '__main__': unittest.main()
