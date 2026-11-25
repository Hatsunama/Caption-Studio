"""Install the pinned runtime-verification tools from the selected runner SDK."""
import os
from pathlib import Path
import re
import subprocess
import sys


def resolve_sdkmanager(env):
    roots = [Path(env[key]).expanduser().resolve(strict=True)
             for key in ('ANDROID_SDK_ROOT', 'ANDROID_HOME') if env.get(key)]
    if not roots or any(root != roots[0] for root in roots):
        raise ValueError('Missing or conflicting Android SDK roots')
    root = roots[0]
    if not root.is_dir() or any(c in str(root) for c in '\r\n'):
        raise ValueError('Invalid Android SDK directory')
    latest = root / 'cmdline-tools/latest'
    if latest.exists() or latest.is_symlink():
        candidates = [latest / 'bin/sdkmanager']
    else:
        candidates = [directory / 'bin/sdkmanager'
                      for directory in (root / 'cmdline-tools').glob('*')
                      if re.fullmatch(r'\d+(?:\.\d+)*', directory.name)
                      and (directory / 'bin/sdkmanager').is_file()]
    if len(candidates) != 1:
        raise ValueError('Missing or ambiguous Android command-line tools')
    manager = candidates[0].resolve(strict=True)
    if not manager.is_relative_to(root) or not manager.is_file():
        raise ValueError('Invalid Android SDK manager')
    if os.name != 'nt' and not os.access(manager, os.X_OK):
        raise ValueError('Android SDK manager is not executable')
    return root, manager


def main():
    if len(sys.argv) != 1:
        print('SDK setup failed: unexpected arguments', file=sys.stderr)
        return 2
    try:
        root, manager = resolve_sdkmanager(os.environ)
        subprocess.run([str(manager), '--sdk_root=' + str(root), 'build-tools;36.0.0'], check=True)
        if os.environ.get('GITHUB_ENV'):
            with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as destination:
                destination.write(f'ANDROID_SDK_ROOT={root}\nANDROID_HOME={root}\n')
        return 0
    except subprocess.CalledProcessError as failure:
        print('SDK setup failed: SDK manager exited unsuccessfully', file=sys.stderr)
        return failure.returncode if 0 < failure.returncode < 126 else 1
    except (OSError, ValueError):
        print('SDK setup failed: invalid SDK configuration or unavailable tool', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
