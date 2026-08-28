/**
 * Inlined `bindSnapshotSelector` — rc.8 dropped this from
 * `@deepseek-ai/dsh-client-ui-renderer`'s package root, so business plugins
 * carry their own copy (same approach as the sidebar-brand-text plugin).
 *
 * @module @huanlin/dsh-plugin-copilot/client/bindSnapshotSelector
 */
import { useRef, useSyncExternalStore } from 'react'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Bind a React selector hook to a {@link HostObservable} snapshot source.
 * @param source - the observable snapshot store.
 * @returns a `useSelector(sel, eq?)` hook.
 */
export function bindSnapshotSelector<T>(source: HostObservable<T>): SnapshotSelectorHook<T> {
  const subscribe = (fn: () => void): (() => void) => source.subscribe(fn)
  const getSnapshot = (): T => source.getSnapshot()
  return function useSelector<S>(sel: (s: T) => S): S {
    const snapshot = useSyncExternalStore(subscribe, getSnapshot)
    const prevSnapshotRef = useRef<T | undefined>(undefined)
    const prevSelectedRef = useRef<S | undefined>(undefined)
    if (prevSnapshotRef.current !== snapshot) {
      prevSnapshotRef.current = snapshot
      prevSelectedRef.current = sel(snapshot)
    }
    return prevSelectedRef.current as S
  }
}
