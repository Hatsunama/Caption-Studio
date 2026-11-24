import { useEffect, useRef, useState } from 'react';

/** Privacy storage state. Listing errors must never imply that storage is empty. */
export function useModelInventory<T>(list: () => Promise<T[]>) {
  const [models, setModels] = useState<T[]>([]);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(false);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    void Promise.resolve().then(list).then((items) => {
      if (!active) return;
      setModels(items);
      setStatus('loaded');
    }, () => {
      if (active) setStatus('error');
    });
    return () => { active = false; mounted.current = false; };
  }, [list, attempt]);

  return {
    models,
    status,
    retry: () => {
      if (!mounted.current) return;
      setStatus('loading');
      setAttempt((value) => value + 1);
    },
    clear: () => {
      if (mounted.current) setModels([]);
    },
  };
}

