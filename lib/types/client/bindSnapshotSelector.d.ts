import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots';
/**
 * Bind a React selector hook to a {@link HostObservable} snapshot source.
 * @param source - the observable snapshot store.
 * @returns a `useSelector(sel, eq?)` hook.
 */
export declare function bindSnapshotSelector<T>(source: HostObservable<T>): SnapshotSelectorHook<T>;
