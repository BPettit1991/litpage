// Session: current user, workspaces (spaces + space_views), active workspace.
import { create } from 'zustand';
import type { SpaceRecord, SpaceViewRecord, UserRootRecord } from '@nc/shared/records.ts';
import { api } from '../api.ts';
import { records } from './records.ts';
import { connectRealtime, disconnectRealtime } from './sync.ts';

interface SessionState {
  status: 'loading' | 'anonymous' | 'ready' | 'onboarding';
  userId: string | null;
  spaceId: string | null;
  load: () => Promise<void>;
  setSpace: (spaceId: string) => void;
  logout: () => Promise<void>;
}

const LAST_SPACE = 'nc:lastSpaceId';

export const useSession = create<SessionState>((set, get) => ({
  status: 'loading',
  userId: null,
  spaceId: null,
  async load() {
    try {
      const res = await api('loadAccountData');
      records.mergeRecordMap(res.recordMap);
      const users = Object.keys(res.recordMap.user_root ?? {});
      const userId = users[0] ?? null;
      const root = records.get<UserRootRecord>('user_root', userId);
      const views = (root?.space_views ?? []).map((id) => records.get<SpaceViewRecord>('space_view', id)).filter(Boolean) as SpaceViewRecord[];
      const spaceIds = views.map((v) => v.space_id).filter((id) => records.get<SpaceRecord>('space', id));
      if (!spaceIds.length) {
        set({ status: 'onboarding', userId });
        return;
      }
      let last: string | null = null;
      try {
        last = localStorage.getItem(LAST_SPACE);
      } catch {
        /* ignore */
      }
      const spaceId = last && spaceIds.includes(last) ? last : spaceIds[0];
      set({ status: 'ready', userId, spaceId });
      connectRealtime(spaceIds);
    } catch (e: any) {
      if (e?.status === 401) set({ status: 'anonymous', userId: null, spaceId: null });
      else {
        console.error(e);
        set({ status: 'anonymous' });
      }
    }
  },
  setSpace(spaceId) {
    try {
      localStorage.setItem(LAST_SPACE, spaceId);
    } catch {
      /* ignore */
    }
    set({ spaceId });
  },
  async logout() {
    await api('signOut');
    disconnectRealtime();
    set({ status: 'anonymous', userId: null, spaceId: null });
    location.href = '/login';
  },
}));

export function currentSpaceView(): SpaceViewRecord | undefined {
  const { userId, spaceId } = useSession.getState();
  const root = records.get<UserRootRecord>('user_root', userId);
  for (const id of root?.space_views ?? []) {
    const sv = records.get<SpaceViewRecord>('space_view', id);
    if (sv?.space_id === spaceId) return sv;
  }
  return undefined;
}
