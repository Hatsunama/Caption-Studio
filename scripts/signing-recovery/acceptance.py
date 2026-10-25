"""Synthetic-only acceptance tests. No installed packages or real signing material."""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).resolve().parent
OPENSSL = os.environ.get('OPENSSL_BIN', 'openssl')
KEYTOOL = os.environ.get('KEYTOOL_BIN', 'keytool')


def ssl(*args, data=None):
    result = subprocess.run([OPENSSL, *map(str, args)], input=data, capture_output=True)
    if result.returncode:
        raise AssertionError('synthetic OpenSSL operation failed')
    return result.stdout


class Acceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='signing-recovery-synthetic-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        for name in ('recipient', 'wrong', 'signer'):
            ssl('req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1',
                '-subj', '/CN=Synthetic-only', '-keyout', cls.root / (name + '.key'),
                '-out', cls.root / (name + '.crt'))
        cls.store = 'synthetic-store-DoNotLog!'
        cls.keypass = 'synthetic-key-DoNotLog!'
        cls.alias = 'synthetic-alias-DoNotLog'
        # Password through stdin, never argv.
        ssl('pkcs12', '-export', '-inkey', cls.root / 'signer.key', '-in', cls.root / 'signer.crt',
            '-name', cls.alias, '-passout', 'stdin', '-out', cls.root / 'synthetic.p12',
            data=(cls.store + '\n').encode())
        cls.keystore = (cls.root / 'synthetic.p12').read_bytes()
        # A real JKS PrivateKeyEntry with the same synthetic certificate; .p12 suffix is intentional.
        child_env = {k: os.environ[k] for k in ('PATH', 'SystemRoot', 'TEMP', 'TMP') if k in os.environ}
        child_env['SYNTHETIC_PASSWORD'] = cls.store
        result = subprocess.run([KEYTOOL, '-J-Xms16m', '-J-Xmx64m', '-J-XX:ActiveProcessorCount=1',
            '-importkeystore', '-noprompt', '-srckeystore', str(cls.root / 'synthetic.p12'),
            '-srcstoretype', 'PKCS12', '-srcstorepass:env', 'SYNTHETIC_PASSWORD',
            '-destkeystore', str(cls.root / 'synthetic-jks.p12'), '-deststoretype', 'JKS',
            '-deststorepass:env', 'SYNTHETIC_PASSWORD'], capture_output=True, env=child_env, timeout=60)
        if result.returncode:
            cls.temp.cleanup()
            raise AssertionError('synthetic JKS generation failed')
        cls.jks = (cls.root / 'synthetic-jks.p12').read_bytes()
        assert cls.jks[:4] == bytes.fromhex('feedfeed')
        cls.pin = hashlib.sha256(ssl('x509', '-in', cls.root / 'recipient.crt', '-outform', 'DER')).hexdigest()
        cls.signer_pin = hashlib.sha256(ssl('x509', '-in', cls.root / 'signer.crt', '-outform', 'DER')).hexdigest()
        ssl('x509', '-in', cls.root / 'recipient.crt', '-signkey', cls.root / 'recipient.key',
            '-days', '0', '-out', cls.root / 'expired.crt')

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.assertTrue((HERE / 'export.py').is_file(), 'exporter is not implemented')
        spec = importlib.util.spec_from_file_location('recovery_export', HERE / 'export.py')
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)
        # In-memory test seam only: production CLI has no pin overrides.
        self.mod.RECIPIENT_SHA256 = self.pin
        self.mod.SIGNING_SHA256 = self.signer_pin
        self.case = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(self.case.cleanup)
        self.runner = Path(self.case.name)
        self.output = self.runner / 'output'
        self.env = {'RUNNER_TEMP': str(self.runner),
                    'CAPTION_STUDIO_FIXED_KEYSTORE_BASE64': base64.b64encode(self.keystore).decode(),
                    'CAPTION_STUDIO_FIXED_STORE_PASSWORD': self.store,
                    'CAPTION_STUDIO_FIXED_KEY_PASSWORD': self.keypass,
                    'CAPTION_STUDIO_FIXED_KEY_ALIAS': self.alias}
        for name in ('PATH', 'SystemRoot', 'TEMP', 'TMP'):
            if os.environ.get(name):
                self.env[name] = os.environ[name]

    def run_export(self, cert=None):
        out, err = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, self.env, clear=True), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = self.mod.main(['--recipient', str(cert or self.root / 'recipient.crt'),
                                  '--output-dir', str(self.output), '--openssl', OPENSSL, '--keytool', KEYTOOL])
        text = out.getvalue() + err.getvalue()
        for secret in (self.store, self.keypass, self.alias, self.env.get('CAPTION_STUDIO_FIXED_KEYSTORE_BASE64', '')):
            if secret:
                self.assertNotIn(secret, text)
        return code, text

    def failed(self):
        code, text = self.run_export()
        self.assertNotEqual(code, 0)
        self.assertEqual(text, 'Signing recovery failed. No recovery artifact was published.\n')
        self.assertEqual(list(self.runner.iterdir()), [])

    def test_roundtrip_and_envelope_and_public_output(self):
        self.assertEqual(self.run_export(), (0, ''))
        self.assertEqual({p.name for p in self.output.iterdir()}, {'recovery.p7m', 'manifest.json'})
        cipher = self.output / 'recovery.p7m'
        description = ssl('cms', '-cmsout', '-print', '-inform', 'DER', '-in', cipher).decode()
        for marker in ('id-smime-ct-authEnvelopedData', 'aes-256-gcm', 'rsaesOaep', 'mgf1', 'sha256'):
            self.assertIn(marker, description)
        plain = ssl('cms', '-decrypt', '-binary', '-inform', 'DER', '-in', cipher,
                    '-recip', self.root / 'recipient.crt', '-inkey', self.root / 'recipient.key')
        with zipfile.ZipFile(io.BytesIO(plain)) as archive:
            self.assertEqual(archive.namelist(), ['keystore.p12', 'store-password.txt', 'key-password.txt', 'alias.txt'])
            for name, value in [('keystore.p12', self.keystore), ('store-password.txt', self.store.encode()),
                                ('key-password.txt', self.keypass.encode()), ('alias.txt', self.alias.encode())]:
                self.assertEqual(archive.read(name), value)
        public = b''.join(p.read_bytes() for p in self.output.iterdir())
        for value in (self.keystore, self.store.encode(), self.keypass.encode(), self.alias.encode()):
            self.assertNotIn(value, public)
        manifest = json.loads((self.output / 'manifest.json').read_text())
        self.assertEqual(manifest['schema_version'], 1)
        self.assertEqual(manifest['payload'], {
            'schema_version': 1, 'format': 'ZIP_STORED', 'files': list(self.mod.FILES),
            'keystore_encoding': 'original base64-decoded keystore bytes (JKS or PKCS#12)',
            'text_encoding': 'UTF-8 without added newline',
            'extra_entries_allowed': False, 'paths_allowed': False})
        self.assertEqual(manifest['ciphertext_sha256'], hashlib.sha256(cipher.read_bytes()).hexdigest())
        self.assertEqual(manifest['recipient_certificate_der_sha256'], self.pin)
        self.assertEqual(manifest['expected_signing_certificate_der_sha256'], self.signer_pin)
        self.assertEqual(list(self.runner.iterdir()), [self.output])
        if os.name != 'nt':
            self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o700)
            for file in self.output.iterdir():
                self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)

    def test_jks_roundtrip(self):
        self.keystore = self.jks
        self.env['CAPTION_STUDIO_FIXED_KEYSTORE_BASE64'] = base64.b64encode(self.keystore).decode()
        self.test_roundtrip_and_envelope_and_public_output()

    def test_wrapped_base64_roundtrip(self):
        self.env['CAPTION_STUDIO_FIXED_KEYSTORE_BASE64'] = base64.encodebytes(self.keystore).decode()
        self.test_roundtrip_and_envelope_and_public_output()

    def test_jks_wrong_password_and_pin_rejected(self):
        self.env['CAPTION_STUDIO_FIXED_KEYSTORE_BASE64'] = base64.b64encode(self.jks).decode()
        self.env['CAPTION_STUDIO_FIXED_STORE_PASSWORD'] = 'wrong'
        self.failed()
        self.env['CAPTION_STUDIO_FIXED_STORE_PASSWORD'] = self.store
        self.mod.SIGNING_SHA256 = '0' * 64
        self.failed()

    def test_base64_garbage_rejected(self):
        valid = base64.b64encode(self.keystore).decode()
        for encoded in (valid[:40] + '*' + valid[40:], valid + '!', valid[:40] + ' ' + valid[40:], valid[:40] + '\r\n' + valid[40:]):
            self.env['CAPTION_STUDIO_FIXED_KEYSTORE_BASE64'] = encoded
            self.failed()

    def test_wrong_recipient_and_tamper_rejected(self):
        self.assertEqual(self.run_export()[0], 0)
        cipher = self.output / 'recovery.p7m'
        def decrypt(path, recipient):
            return subprocess.run([OPENSSL, 'cms', '-decrypt', '-binary', '-inform', 'DER', '-in', str(path),
                '-recip', str(self.root / (recipient + '.crt')), '-inkey', str(self.root / (recipient + '.key'))],
                capture_output=True).returncode
        self.assertNotEqual(decrypt(cipher, 'wrong'), 0)
        blob = bytearray(cipher.read_bytes())
        for offset in (len(blob) // 2, len(blob) - 1):
            changed = bytearray(blob)
            changed[offset] ^= 1
            tampered = self.runner / 'tampered.p7m'
            tampered.write_bytes(changed)
            self.assertNotEqual(decrypt(tampered, 'recipient'), 0)

    def test_missing_each_secret(self):
        for key in list(self.env):
            if key.startswith('CAPTION_'):
                with self.subTest(key=key):
                    old = self.env.pop(key)
                    self.failed()
                    self.env[key] = old

    def test_malformed_secrets(self):
        for key, value in [('KEYSTORE_BASE64', 'invalid***'), ('KEYSTORE_BASE64', base64.b64encode(b'not p12').decode()),
                           ('STORE_PASSWORD', 'wrong'), ('KEY_PASSWORD', ''), ('KEY_ALIAS', '../bad\nvalue')]:
            key = 'CAPTION_STUDIO_FIXED_' + key
            with self.subTest(key=key):
                old = self.env[key]
                self.env[key] = value
                self.failed()
                self.env[key] = old

    def test_recipient_pin_rejected(self):
        self.assertNotEqual(self.run_export(self.root / 'wrong.crt')[0], 0)
        self.assertEqual(list(self.runner.iterdir()), [])

    def test_signing_pin_rejected(self):
        self.mod.SIGNING_SHA256 = '0' * 64
        self.failed()

    def test_expiry_failure(self):
        expired = self.root / 'expired.crt'
        self.mod.RECIPIENT_SHA256 = hashlib.sha256(ssl('x509', '-in', expired, '-outform', 'DER')).hexdigest()
        self.assertNotEqual(self.run_export(expired)[0], 0)
        self.assertEqual(list(self.runner.iterdir()), [])

    def test_recipient_expiry_checked_before_credentials(self):
        original = self.mod.openssl
        checked = []
        test = self
        class GuardedEnvironment(dict):
            def pop(self, name, *args):
                if name.startswith('CAPTION_'):
                    test.assertTrue(checked, 'credentials accessed before recipient expiry check')
                return super().pop(name, *args)
        def inspect(args, **kwargs):
            result = original(args, **kwargs)
            if '-checkend' in args:
                self.assertTrue(all(name in os.environ for name in self.mod.SECRET_NAMES))
                checked.append(True)
            return result
        with patch.object(os, 'environ', GuardedEnvironment()), patch.object(self.mod, 'openssl', inspect):
            self.assertEqual(self.run_export(), (0, ''))
        self.assertTrue(checked)

    def test_child_environment_does_not_inherit_secrets(self):
        self.env['JAVA_TOOL_OPTIONS'] = '-untrusted'
        self.env['_JAVA_OPTIONS'] = '-untrusted'
        self.env['JDK_JAVA_OPTIONS'] = '-untrusted'
        original = self.mod.subprocess.run
        observed = []
        def inspect(*args, **kwargs):
            child_env = kwargs['env']
            self.assertFalse(any(name.startswith('CAPTION_') for name in child_env))
            command = args[0]
            if '-storepass:env' in command:
                self.assertEqual(child_env.get('RECOVERY_STORE_PASSWORD'), self.store)
            else:
                self.assertNotIn('RECOVERY_STORE_PASSWORD', child_env)
            self.assertNotIn(self.store, command)
            self.assertNotIn(self.keypass, command)
            self.assertNotIn(self.alias, command)
            self.assertEqual(kwargs['stdout'], subprocess.PIPE)
            self.assertEqual(kwargs['stderr'], subprocess.PIPE)
            self.assertNotIn('JAVA_TOOL_OPTIONS', child_env)
            self.assertNotIn('_JAVA_OPTIONS', child_env)
            self.assertNotIn('JDK_JAVA_OPTIONS', child_env)
            if '-list' in command:
                self.assertIn('-J-Xmx64m', command)
                self.assertIn('-J-XX:ActiveProcessorCount=1', command)
                self.assertNotIn('-alias', command)
            observed.append(command[1])
            return original(*args, **kwargs)
        with patch.object(self.mod.subprocess, 'run', inspect):
            self.assertEqual(self.run_export(), (0, ''))
        self.assertIn('cms', observed)
        self.assertIn('-J-Xms16m', observed)

    def test_ambiguous_public_certificates_rejected(self):
        original = self.mod.captured_tool
        def duplicate(executable, args, **kwargs):
            result = original(executable, args, **kwargs)
            if '-list' in args:
                return result + result
            return result
        with patch.object(self.mod, 'captured_tool', duplicate):
            self.failed()

    def test_keytool_failure_output_stays_private_and_cleans_up(self):
        original = self.mod.subprocess.run
        def reject(command, **kwargs):
            if '-list' in command:
                return subprocess.CompletedProcess(command, 1, self.alias.encode(), self.store.encode())
            return original(command, **kwargs)
        with patch.object(self.mod.subprocess, 'run', reject):
            self.failed()

    def test_partial_publication_failure_cleans_all_outputs(self):
        original = self.mod.private_file
        def reject(path, data):
            if path.name == 'manifest.json':
                raise OSError(self.store)
            return original(path, data)
        with patch.object(self.mod, 'private_file', reject):
            self.failed()

    def test_temporary_cleanup_completes_before_publication(self):
        original = self.mod.tempfile.TemporaryDirectory
        class CleanupFailure(original):
            def __exit__(self, *args):
                super().__exit__(*args)
                raise OSError('synthetic cleanup failure')
        with patch.object(self.mod.tempfile, 'TemporaryDirectory', CleanupFailure):
            self.failed()

    def test_production_pins_cannot_be_overridden_by_environment(self):
        self.mod.RECIPIENT_SHA256 = '0' * 64
        self.env['RECIPIENT_SHA256'] = self.pin
        self.env['SIGNING_SHA256'] = self.signer_pin
        self.failed()

    def test_checked_in_public_certificate_matches_fixed_pin(self):
        spec = importlib.util.spec_from_file_location('unmodified_recovery', HERE / 'export.py')
        production = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(production)
        # These literals came from the user's out-of-band approval, not a repository-derived pin.
        self.assertEqual(production.RECIPIENT_SHA256, '5be66294eff75a2c9aee7ca70d71b94c740113a768f26f46b6c75346cc72e6a4')
        self.assertEqual(production.SIGNING_SHA256, 'd02d23b28cbc615e3686d181aedefbbe5de993a0b6ba3f8e4ea2b6160211b35f')
        public_der = ssl('x509', '-in', HERE / 'recipient.crt', '-outform', 'DER')
        self.assertEqual(hashlib.sha256(public_der).hexdigest(), production.RECIPIENT_SHA256)

    def test_no_overwrite(self):
        self.output.mkdir()
        sentinel = self.output / 'sentinel'
        sentinel.write_text('keep')
        self.assertNotEqual(self.run_export()[0], 0)
        self.assertEqual(sentinel.read_text(), 'keep')
        self.assertEqual(list(self.runner.iterdir()), [self.output])

    def test_requires_runner_temp_and_containment(self):
        self.env.pop('RUNNER_TEMP')
        self.failed()
        self.env['RUNNER_TEMP'] = str(self.runner / 'missing')
        self.failed()
        self.env['RUNNER_TEMP'] = str(self.runner)
        self.output = self.root / 'escape-output'
        self.assertNotEqual(self.run_export()[0], 0)
        self.assertFalse(self.output.exists())

    @unittest.skipIf(os.name == 'nt', 'POSIX modes/symlinks verified on Ubuntu; Windows ACLs are inherited')
    def test_symlink_output_rejected(self):
        link = self.runner / 'link'
        link.symlink_to(self.root, target_is_directory=True)
        self.output = link / 'escaped'
        self.assertNotEqual(self.run_export()[0], 0)
        self.assertFalse(self.output.exists())

    def test_restrictive_temp_and_cleanup_on_encryption_failure(self):
        original = self.mod.openssl
        observed = []
        def fail(args, **kwargs):
            if args[0] == 'cms':
                plain = Path(args[args.index('-in') + 1])
                observed.append(plain)
                self.assertTrue(plain.is_relative_to(self.runner))
                if os.name != 'nt':
                    self.assertEqual(stat.S_IMODE(plain.stat().st_mode), 0o600)
                    self.assertEqual(stat.S_IMODE(plain.parent.stat().st_mode), 0o700)
                raise ValueError(self.store + self.keypass + self.alias)
            return original(args, **kwargs)
        with patch.object(self.mod, 'openssl', fail):
            self.failed()
        self.assertTrue(observed)
        self.assertFalse(observed[0].exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
