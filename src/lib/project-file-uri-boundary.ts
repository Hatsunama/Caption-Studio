type AppStorageRoots = {
  documentDirectory: string | null | undefined;
  cacheDirectory: string | null | undefined;
};

function decodedFilePath(uri: string, label: string, directory: boolean): string {
  if (!uri.startsWith('file:///') || uri.length > 16_384 || /[?#\\\0]/.test(uri)) {
    throw new Error(`${label} is not an app-owned file`);
  }
  let decoded = uri;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new Error(`${label} contains an invalid file path`);
    }
    if (next === decoded) break;
    decoded = next;
    if (attempt === 7) throw new Error(`${label} contains an invalid file path`);
  }
  if (!decoded.startsWith('file:///') || /[?#\\\0]/.test(decoded)) {
    throw new Error(`${label} contains an invalid file path`);
  }
  const path = decoded.slice('file://'.length);
  const segments = path.split('/');
  if (
    (directory && !path.endsWith('/'))
    || (!directory && path.endsWith('/'))
    || segments.some((segment, index) => index > 0
      && (segment === '.' || segment === '..' || (segment === '' && index < segments.length - 1)))
  ) throw new Error(`${label} contains an invalid file path`);
  return path;
}

export function assertProjectMediaReferences(project: unknown, roots: AppStorageRoots): void {
  const allowedRoots = [roots.documentDirectory, roots.cacheDirectory]
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
    .map((root) => decodedFilePath(root, 'App storage', true));
  const pending: unknown[] = [project];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (/uri$/i.test(key) && child != null) {
        if (typeof child !== 'string') throw new Error(`${key} contains an invalid media URI`);
        if (child.startsWith('content://')) continue;
        const path = decodedFilePath(child, key, false);
        if (!allowedRoots.some((root) => path.startsWith(root))) {
          throw new Error(`${key} is not an app-owned file`);
        }
      } else if (child && typeof child === 'object') {
        pending.push(child);
      }
    }
  }
}
