import type { CaptionProject } from '@/types/project';

export type EditorPublication = {
  before: CaptionProject;
  project: CaptionProject;
  revision: number;
  generation: number;
};

export type EditorProjectOperation = (before: CaptionProject) => CaptionProject | null | Promise<CaptionProject | null>;

export function createEditorSession(
  initialProject: CaptionProject,
  publish: (next: CaptionProject) => void,
  write: (next: CaptionProject) => Promise<CaptionProject>,
  remember: (before: CaptionProject) => void = () => undefined,
) {
  let current = initialProject;
  let revision = 0;
  let generation = 0;
  let active = true;
  let closing = false;
  let tail: Promise<unknown> = Promise.resolve();
  const editable = () => active && !closing;
  const assertActive = (expected: number) => {
    if (!active || generation !== expected) throw new Error('This editor session has closed.');
  };
  const enqueue = <T,>(operation: (expected: number) => Promise<T>) => {
    const expected = generation;
    const task = tail.then(() => { assertActive(expected); return operation(expected); });
    tail = task.catch(() => undefined);
    return task;
  };
  const update = (change: CaptionProject | ((before: CaptionProject) => CaptionProject)) => {
    if (!editable()) return;
    const next = typeof change === 'function' ? change(current) : change;
    if (next === current) return;
    current = next;
    revision += 1;
    publish(next);
  };
  const checkpointLatest = async (expected: number) => {
    for (;;) {
      assertActive(expected);
      const started = revision;
      await write(current);
      assertActive(expected);
      if (started === revision) return current;
    }
  };
  const commit = (operation: EditorProjectOperation, alreadyPersists = false) => {
    if (!editable()) return Promise.reject(new Error('Finish leaving the editor before making more changes.'));
    return enqueue(async (expected): Promise<EditorPublication | null> => {
      const before = current;
      const started = revision;
      let next: CaptionProject | null;
      try {
        next = await operation(before);
        assertActive(expected);
        if (!next) return null;
        if (revision === started && !alreadyPersists && next !== before) await write(next);
      } catch (caught) {
        if (active && generation === expected && (alreadyPersists || revision !== started)) {
          await checkpointLatest(expected);
        }
        throw caught;
      }
      assertActive(expected);
      if (revision !== started) {
        await checkpointLatest(expected);
        throw new Error('The project changed while this action was saving. Newer edits were kept. Try the action again.');
      }
      if (next !== before) {
        remember(before);
        current = next;
        revision += 1;
        publish(next);
      }
      return { before, project: next, revision, generation: expected };
    });
  };
  return {
    current: () => current,
    setHistoryRecorder: (recorder: (before: CaptionProject) => void) => { remember = recorder; },
    editable,
    update,
    commit,
    isCurrent: (receipt: EditorPublication | null) => Boolean(receipt && active
      && receipt.generation === generation && receipt.revision === revision),
    checkpoint: () => editable() ? enqueue(checkpointLatest) : Promise.resolve(current),
    finish: (operation: (latest: CaptionProject) => Promise<CaptionProject | null>) => {
      if (!editable()) return Promise.reject(new Error('This editor session is already closing.'));
      closing = true;
      return enqueue(async (expected) => {
        try {
          const saved = await operation(current);
          assertActive(expected);
          if (saved) {
            current = saved;
            revision += 1;
            publish(saved);
          }
          active = false;
        } catch (caught) {
          closing = false;
          throw caught;
        }
      });
    },
    activate: () => { active = true; },
    dispose: () => { active = false; generation += 1; },
  };
}
