import {fetchJson} from '../lit/shared/catalog';
import {readCommunityViewer, type CommunityViewer} from './community-viewer';
import type {CommunityForum, ForumGroup} from './community-forums';

export interface CommunityForumDirectory {
  viewer: CommunityViewer;
  forums: CommunityForum[];
  groups: ForumGroup[];
}
interface PendingDirectory {
  controller: AbortController;
  promise: Promise<CommunityForumDirectory>;
  observers: Set<(viewer: CommunityViewer) => void>;
  viewer?: CommunityViewer;
  users: number;
}
let pending: PendingDirectory | undefined;

/** Only concurrent reads share a request; completed private DTOs are never cached. */
export function readCommunityForumDirectory(
  signal: AbortSignal, onViewer?: (viewer: CommunityViewer) => void,
): Promise<CommunityForumDirectory> {
  signal.throwIfAborted();
  if (!pending) {
    const controller = new AbortController();
    const job: PendingDirectory = {controller, observers: new Set(), users: 0, promise: undefined!};
    pending = job;
    job.promise = (async () => {
      const viewer = await readCommunityViewer(controller.signal);
      controller.signal.throwIfAborted();
      job.viewer = viewer;
      for (const observer of job.observers) observer(structuredClone(viewer));
      const data = await fetchJson<{forums?: CommunityForum[]; groups?: ForumGroup[]}>(
        '/api/v1/community/forums', {credentials: 'same-origin', cache: 'no-store', signal: controller.signal},
      );
      controller.signal.throwIfAborted();
      return {viewer, forums: Array.isArray(data.forums) ? data.forums : [], groups: Array.isArray(data.groups) ? data.groups : []};
    })().finally(() => {if (pending === job) pending = undefined;});
  }
  const job = pending;
  job.users++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: CommunityForumDirectory) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (onViewer) job.observers.delete(onViewer);
      if (--job.users === 0 && pending === job) {
        pending = undefined;
        job.controller.abort();
      }
      if (error !== undefined) reject(error); else resolve(structuredClone(value!));
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    if (onViewer) {
      job.observers.add(onViewer);
      if (job.viewer) onViewer(structuredClone(job.viewer));
    }
    job.promise.then(value => finish(undefined, value), error => finish(error));
  });
}

export function invalidateCommunityForumDirectory(): void {
  const job = pending;
  pending = undefined;
  job?.controller.abort();
}
if (typeof window !== 'undefined') {
  window.addEventListener('haneoka:session-changed', invalidateCommunityForumDirectory);
  window.addEventListener('haneoka:community-forums-changed', invalidateCommunityForumDirectory);
}
