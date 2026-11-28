"""Temporary owner-only diagnostic launcher. Python stdlib; official SDK tools only."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

BRANCH = 'refs/heads/codex/final150-runtime-diagnostic'
CONTEXT = {
    'GITHUB_ACTIONS': 'true',
    'GITHUB_EVENT_NAME': 'workflow_dispatch',
    'GITHUB_REPOSITORY': 'Hatsunama/Caption-Studio',
    'GITHUB_REPOSITORY_OWNER': 'Hatsunama',
    'GITHUB_REF': BRANCH,
    'GITHUB_ACTOR': 'Hatsunama',
    'GITHUB_TRIGGERING_ACTOR': 'Hatsunama',
    'GITHUB_WORKFLOW_REF': 'Hatsunama/Caption-Studio/.github/workflows/verify-final-android-runtime.yml@' + BRANCH,
}
MATRIX = {'24': ('x86', '1536M'), '25': ('x86_64', '6144M'), '26': ('x86_64', '6144M')}
SERIAL = 'emulator-5554'
NDK = '27.1.12297006'
OUTPUT_LIMIT = 16384


def assert_context(env):
    if any(env.get(k) != v for k, v in CONTEXT.items()):
        raise ValueError('diagnostic context rejected')
    if any(env.get(k) for k in ('GH_TOKEN', 'GITHUB_TOKEN', 'ADB_SERVER_SOCKET',
                               'ANDROID_ADB_SERVER_PORT', 'ADB_SERVER_PORT', 'ANDROID_SERIAL')):
        raise ValueError('token or device redirection rejected')


def assert_devices(output, owned):
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    expected = ['List of devices attached'] + ([SERIAL + '\tdevice'] if owned else [])
    if lines != expected:
        raise ValueError('unexpected ADB devices')


def stop_group(process):
    # Only a process/group created by this launcher; never an ADB server or device.
    # Contract: caller created this child with start_new_session=True on POSIX.
    group = os.name == 'posix'
    def send(sig):
        try:
            if group:
                os.killpg(process.pid, sig)
            elif process.poll() is None:
                process.terminate() if sig == signal.SIGTERM else process.kill()
        except ProcessLookupError:
            pass
    send(signal.SIGTERM)
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass
    # A launcher wrapper can exit before its qemu child. Kill remaining group too.
    send(signal.SIGKILL if os.name == 'posix' else signal.SIGTERM)
    process.wait(timeout=3)


def run_child(argv, env, timeout, input_text=None, capture=True, diagnostic=False):
    if timeout <= 0:
        raise TimeoutError('deadline expired')
    # Spool official setup IO outside memory; retain only a bounded tail on failure.
    output = tempfile.TemporaryFile() if diagnostic else None
    p = None
    try:
        p = subprocess.Popen(argv, env=env, stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
                             stdout=output if diagnostic else subprocess.PIPE if capture else subprocess.DEVNULL,
                             stderr=subprocess.STDOUT if diagnostic else subprocess.DEVNULL,
                             text=True, start_new_session=(os.name == 'posix'))
        out, _ = p.communicate(input_text, timeout=timeout)
        if p.returncode:
            raise subprocess.CalledProcessError(p.returncode, argv)
        return out or ''
    except BaseException as failure:
        if p is not None:
            try:
                stop_group(p)
            except (OSError, subprocess.TimeoutExpired):
                pass  # Preserve the original child failure or timeout.
        if output is not None:
            try:
                output.seek(0, os.SEEK_END)
                output.seek(max(0, output.tell() - OUTPUT_LIMIT))
                # Ignore partial UTF8 at the tail boundary; encoded result stays <=16KiB.
                failure.public_output = output.read(OUTPUT_LIMIT).decode('utf-8', errors='ignore')
            except OSError:
                pass
        raise
    finally:
        if p is not None:
            for stream in (p.stdin, p.stdout):
                if stream:
                    stream.close()
        if output is not None:
            output.close()


def unlock(adb):
    for attempt in range(3):
        try:
            adb('shell', 'input', 'keyevent', '82')
            return
        except subprocess.TimeoutExpired:
            if attempt == 2:
                raise


def lifecycle(process, verify, cleanup, events=None):
    code = 0
    clean = True
    try:
        verify()
    except subprocess.CalledProcessError as failure:
        code = failure.returncode
        if events is not None:
            events.append({'stage': 'child-failed', 'exit': code})
    except (OSError, ValueError, TimeoutError, subprocess.TimeoutExpired) as failure:
        code = 1
        if events is not None:
            events.append({'stage': 'launch-failed', 'kind': type(failure).__name__})
    finally:
        try:
            cleanup(process)
        except (OSError, subprocess.TimeoutExpired):
            clean = False
    return (code if code else (0 if clean else 1)), clean


def resolve_tools(env):
    # Reuse exactly the existing resolver; no alternate SDK search or bootstrap.
    path = Path(__file__).with_name('install-runtime-android-build-tools.py')
    spec = importlib.util.spec_from_file_location('runtime_sdk', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.resolve_sdkmanager(env)


def ensure_ndk(root, manager, env, events, runner=run_child):
    ndk = root / 'ndk' / NDK
    events.append({'stage': 'ndk-verify'})
    # A redirected package directory must not redirect the SDK install or verifier.
    if ndk.resolve() != ndk:
        raise ValueError('NDK path redirected')
    if not ndk.exists():
        events.append({'stage': 'ndk-install'})
        runner([str(manager), '--sdk_root=' + str(root), '--install', 'ndk;' + NDK],
               env, 600, input_text='y\n' * 100, diagnostic=True)
        events.append({'stage': 'ndk-verify'})
    if not ndk.is_dir() or ndk.resolve(strict=True) != ndk:
        raise ValueError('NDK package path rejected')
    properties = ndk / 'source.properties'
    package = ndk / 'package.xml'
    if any(p.resolve(strict=True).parent != ndk for p in (properties, package)):
        raise ValueError('NDK metadata redirected')
    revisions = [line.split('=', 1)[1].strip() for line in properties.read_text().splitlines()
                 if '=' in line and line.split('=', 1)[0].strip() == 'Pkg.Revision']
    try:
        packages = [element.attrib.get('path') for element in ET.parse(package).getroot().iter()
                    if element.tag.rsplit('}', 1)[-1] == 'localPackage']
    except ET.ParseError as failure:
        raise ValueError('NDK package metadata rejected') from failure
    if revisions != [NDK] or packages != ['ndk;' + NDK]:
        raise ValueError('NDK exact package/revision rejected')


def boot_and_verify(process, env, adb_path, api, arch, events, boot_seconds=600, runner=run_child):
    deadline = time.monotonic() + boot_seconds
    def probe(*args):
        assert_context({**env, 'ANDROID_SERIAL': ''})
        if process.poll() is not None:
            raise ValueError('emulator host exited')
        remaining = deadline - time.monotonic()
        return runner([str(adb_path), *args], env, min(5, remaining))
    # During connection establishment only this exact serial may be offline.
    while True:
        data = probe('devices')
        lines = [line.strip() for line in data.splitlines() if line.strip()]
        if lines == ['List of devices attached', SERIAL + '\tdevice']:
            break
        if lines not in (['List of devices attached'], ['List of devices attached', SERIAL + '\toffline']):
            raise ValueError('foreign device during boot')
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    def adb(*args):
        assert_devices(probe('devices'), True)
        return probe('-s', SERIAL, *args)
    if adb('shell', 'getprop', 'ro.kernel.qemu').strip() != '1':
        raise ValueError('qemu identity rejected')
    events.append({'stage': 'qemu-identity-confirmed'})
    while adb('shell', 'getprop', 'sys.boot_completed').strip() != '1':
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    events.append({'stage': 'boot-completed'})
    while True:
        service = adb('shell', 'service', 'check', 'input').strip()
        if service == 'Service input: found':
            break
        if service != 'Service input: not found':
            raise ValueError('unexpected input service response')
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    events.append({'stage': 'input-service-ready'})
    unlock(adb)
    events.append({'stage': 'unlock-completed'})
    adb('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '0')
    assert_devices(probe('devices'), True)
    events.append({'stage': 'verifier-started'})
    # Exact existing shell entry point and arguments. No install/parser changes.
    runner(['bash', 'scripts/verify-android-native-compatibility-runtime.sh', api, arch],
              env, 1200, capture=False)
    events.append({'stage': 'verifier-passed'})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--api', required=True, choices=MATRIX)
    parser.add_argument('--arch', required=True)
    args = parser.parse_args()
    env = dict(os.environ)
    events = [{'stage': 'context-check'}]
    code, clean = 1, None
    process = None
    evidence = Path('evidence/final-runtime/emulator-launch.json')
    try:
        assert_context(env)
        if sys.platform != 'linux' or MATRIX[args.api][0] != args.arch:
            raise ValueError('Linux diagnostic matrix required')
        temp_root = Path(env['RUNNER_TEMP']).resolve(strict=True)
        events.append({'stage': 'sdk-resolve'})
        root, manager = resolve_tools(env)
        if not os.access('/dev/kvm', os.R_OK | os.W_OK):
            raise ValueError('KVM setup required')
        env['PATH'] = os.pathsep.join([str(root / 'platform-tools'), str(manager.parent), str(root / 'emulator'), env.get('PATH', '')])
        events.append({'stage': 'build-tools-verify'})
        if not (root / 'build-tools/36.0.0/source.properties').is_file():
            raise ValueError('approved Build Tools36 missing')
        image = f'system-images;android-{args.api};google_apis;{args.arch}'
        events.append({'stage': 'sdk-licenses'})
        run_child([str(manager), '--sdk_root=' + str(root), '--licenses'], env, 120,
                  input_text='y\n' * 100, diagnostic=True)
        events.append({'stage': 'sdk-package-install'})
        run_child([str(manager), '--sdk_root=' + str(root), '--install', 'emulator', 'platform-tools', image],
                  env, 600, input_text='y\n' * 100, diagnostic=True)
        ensure_ndk(root, manager, env, events, runner=run_child)
        events.append({'stage': 'official-sdk-ready'})
        adb = root / 'platform-tools/adb'
        assert_devices(run_child([str(adb), 'devices'], env, 5), False)
        owned = Path(tempfile.mkdtemp(prefix='bounded-emulator-', dir=temp_root))
        env.update(ANDROID_AVD_HOME=str(owned / 'avd'), ANDROID_USER_HOME=str(owned / 'android'),
                   ANDROID_EMULATOR_HOME=str(owned / 'emulator'), ANDROID_SDK_HOME=str(owned),
                   ANDROID_HOME=str(root), ANDROID_SDK_ROOT=str(root))
        Path(env['ANDROID_AVD_HOME']).mkdir()
        avdmanager = manager.parent / 'avdmanager'
        events.append({'stage': 'avd-create'})
        run_child([str(avdmanager), 'create', 'avd', '--force', '--name', 'bounded-runtime', '--package', image],
                  env, 120, input_text='no\n', diagnostic=True)
        events.append({'stage': 'avd-config'})
        config = Path(env['ANDROID_AVD_HOME']) / 'bounded-runtime.avd/config.ini'
        overrides = {'hw.cpu.ncore': '2', 'hw.ramSize': MATRIX[args.api][1], 'hw.heapSize': '256',
                     'disk.dataPartition.size': '4096M', 'hw.keyboard': 'yes'}
        lines = [line for line in config.read_text().splitlines() if line.split('=', 1)[0].strip() not in overrides]
        config.write_text('\n'.join(lines + [f'{k}={v}' for k, v in overrides.items()]) + '\n')
        assert_context(env)
        assert_devices(run_child([str(adb), 'devices'], env, 5), False)
        events.append({'stage': 'fresh-avd-created', 'api': args.api, 'arch': args.arch,
                       'ram': MATRIX[args.api][1], 'port': 5554})
        env.update(ANDROID_SERIAL=SERIAL, EMULATOR_PORT='5554')
        events.append({'stage': 'emulator-spawn'})
        process = subprocess.Popen([str(root / 'emulator/emulator'), '-avd', 'bounded-runtime', '-port', '5554',
                                    '-no-window', '-no-snapshot', '-noaudio', '-no-boot-anim',
                                    '-gpu', 'swiftshader_indirect', '-camera-back', 'none', '-camera-front', 'none'],
                                   env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
        code, clean = lifecycle(process, lambda: boot_and_verify(process, env, adb, args.api, args.arch, events), stop_group, events)
    except (OSError, ValueError, KeyError, TimeoutError, subprocess.SubprocessError) as failure:
        if isinstance(failure, subprocess.CalledProcessError):
            code = failure.returncode
        detail = {'stage': events[-1]['stage'], 'status': 'failed',
                  'kind': type(failure).__name__, 'exit': code}
        if hasattr(failure, 'public_output'):
            detail['outputTail'] = failure.public_output
        events.append(detail)
    finally:
        if process is not None and clean is None:
            try:
                stop_group(process)
                clean = True
            except (OSError, subprocess.TimeoutExpired):
                clean = False
                code = code or 1
        # Fixed stages and bounded official SDK failure tails only; no app output or environment dumps.
        try:
            evidence.parent.mkdir(parents=True, exist_ok=True)
            evidence.write_text(json.dumps({'schema': 1, 'events': events[:32], 'exit': code,
                                            'hostCleanupSucceeded': clean}, indent=2) + '\n')
        except OSError:
            code = code or 1  # Evidence failure must not replace a verifier failure.
    return code


def interrupted(signum, frame):
    raise InterruptedError('launcher interrupted')


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(main())
