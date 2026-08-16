/**
 * The till's session: the shared store plus the one capability only this app
 * has — a local database.
 *
 * Caching the identity is what makes a reload on dead wifi survivable. It
 * grants nothing: the moment a real request goes out, the httpOnly cookie is
 * still the only thing that decides. The cache is capped at the session's own
 * lifetime and wiped on logout.
 */

import { createSessionStore, type SessionPersistence } from '@pos/web-kit';
import { api } from './api-client.js';
import { forgetIdentity, loadIdentity, saveIdentity } from './offline/catalog.js';
import { clearLocalData } from './offline/db.js';
import { totalUnsent } from './offline/outbox.js';

const persistence: SessionPersistence = {
  save: saveIdentity,
  load: async () => {
    const cached = await loadIdentity();
    return cached ? { user: cached.user, branch: cached.branch } : null;
  },
  forget: forgetIdentity,
  clearAll: clearLocalData,
  unsentCount: totalUnsent,
};

export const useSession = createSessionStore({ api, persistence });
