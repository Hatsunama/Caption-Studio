import type { FontChoice } from '@/lib/font-catalog';

type Library = { imported: FontChoice[]; favorites: string[]; recent: string[] };
type Services = {
  loadFontLibrary: () => Promise<Library>;
  importFontFromDevice: () => Promise<FontChoice | null | undefined>;
  saveFontFavorites: (ids: string[]) => Promise<unknown>;
  saveRecentFonts: (ids: string[]) => Promise<unknown>;
};
type Preference = 'favorites' | 'recent';
type Operation = { kind: Preference; id: string; owner: number | undefined; version: number };

// Owns browser state only. The storage service owns font registration and files.
export function createFontLibraryController(
  services: Services,
  notify: (title: string, message: string) => void,
) {
  let snapshot: Library = { imported: [], favorites: ['bungee', 'monoton', 'rubik-glitch'], recent: [] };
  let confirmedFavorites = snapshot.favorites;
  let serial = 0;
  let session: number | undefined;
  let writes = Promise.resolve();
  let hydrated = false;
  const pending: Operation[] = [];
  const revision = { favorites: 0, recent: 0 };
  const dirty = { favorites: false, recent: false };
  const listeners = new Set<() => void>();
  const current = (owner: number | undefined) => owner !== undefined && session === owner;
  const publish = (patch: Partial<Library>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const report = (owner: number | undefined, title: string, error: unknown, fallback: string) => {
    if (current(owner)) notify(title, error instanceof Error ? error.message : fallback);
  };
  const mergeImported = (incoming: FontChoice[]) => {
    const seen = new Set<string>();
    return [...snapshot.imported, ...incoming].filter((choice) => {
      if (seen.has(choice.font.id)) return false;
      seen.add(choice.font.id);
      return true;
    });
  };

  function apply(kind: Preference, ids: string[], id: string) {
    return kind === 'recent' ? [id, ...ids.filter((item) => item !== id)].slice(0, 8)
      : ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
  }

  function enqueue({ kind, owner, version }: Operation, ids: string[]) {
    // Each queued job handles rejection so a failed save cannot poison later jobs.
    writes = writes.then(async () => {
      try {
        if (kind === 'favorites') await services.saveFontFavorites([...ids]);
        else await services.saveRecentFonts([...ids]);
        if (kind === 'favorites') confirmedFavorites = ids;
        if (revision[kind] === version) dirty[kind] = false;
      } catch (error) {
        if (kind === 'favorites' && revision.favorites === version) {
          dirty.favorites = false;
          publish({ favorites: confirmedFavorites });
        }
        // History failure never rolls back the user's selected font or history.
        report(owner, kind === 'favorites' ? 'Could not save favorites' : 'Could not save recent fonts',
          error, 'Font preferences could not be saved.');
      }
    });
  }

  function persist(kind: Preference, id: string) {
    const operation = { kind, id, owner: session, version: ++revision[kind] };
    const ids = apply(kind, snapshot[kind], id);
    dirty[kind] = true;
    if (hydrated) enqueue(operation, ids);
    else pending.push(operation);
    publish({ [kind]: ids });
  }

  function open() {
    const owner = ++serial;
    session = owner;
    const atStart = { ...revision };
    const unsaved = { ...dirty };
    void (async () => {
      try {
        const library = await services.loadFontLibrary();
        if (!current(owner)) return;
        const patch: Partial<Library> = { imported: mergeImported(library.imported) };
        if (!hydrated) {
          // Only a successful read establishes the base for preference writes.
          const rebased = { favorites: [...library.favorites], recent: [...library.recent] };
          confirmedFavorites = rebased.favorites;
          hydrated = true;
          for (const operation of pending) {
            const ids = apply(operation.kind, rebased[operation.kind], operation.id);
            rebased[operation.kind] = ids;
            enqueue(operation, ids);
          }
          pending.length = 0;
          publish({ ...patch, ...rebased });
          return;
        }
        for (const kind of ['favorites', 'recent'] as const) {
          if (!unsaved[kind] && revision[kind] === atStart[kind]) {
            patch[kind] = [...library[kind]];
            if (kind === 'favorites') confirmedFavorites = patch[kind]!;
          }
        }
        publish(patch);
      } catch (error) {
        report(owner, 'Could not load fonts', error, 'Font storage is unavailable.');
      }
    })();
    return () => { if (current(owner)) session = undefined; };
  }

  async function importFont(): Promise<boolean> {
    const owner = session;
    if (!current(owner)) return false;
    try {
      const choice = await services.importFontFromDevice();
      if (!choice) return false;
      // A durable service result survives close/unmount; never delete its assets.
      publish({ imported: [choice, ...snapshot.imported.filter((item) => item.font.id !== choice.font.id)] });
      return current(owner);
    } catch (error) {
      report(owner, 'Could not import font', error, 'The selected font could not be saved.');
      return false;
    }
  }

  return {
    open,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    importFont,
    rememberFont(id: string) {
      persist('recent', id);
    },
    toggleFavorite(id: string) {
      persist('favorites', id);
    },
  };
}
