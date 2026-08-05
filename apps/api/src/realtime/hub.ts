/**
 * The live broadcast hub.
 *
 * One process, one in-memory map of branchId -> open sockets. That is enough
 * and deliberately so: this is a modular monolith on a mini-PC in the shop, and
 * a Redis pub/sub between two halves of the same process would be a moving part
 * with nothing to move. The day a second API instance exists (it does not, and
 * multi-branch in Step 10 is separate DATABASES not separate processes) this is
 * the one file that changes.
 *
 * SOCKETS ARE SCOPED TO A BRANCH AT JOIN TIME, from the session's branchId.
 * A client never names the room it wants — otherwise a cashier's tablet could
 * ask for another shop's kitchen traffic just by editing a string.
 */

import type { LiveEvent } from '@pos/shared';

/**
 * The bit of a WebSocket this file needs.
 *
 * Structural rather than `import type { WebSocket }` so the hub can be tested
 * without opening a real socket — the tests are about who receives what, not
 * about the ws library.
 */
export interface LiveSocket {
  send(data: string): void;
  /** ws exposes 1 for OPEN. Absent on the fakes in the tests. */
  readyState?: number;
}

const OPEN = 1;

export class LiveHub {
  private readonly rooms = new Map<string, Set<LiveSocket>>();

  /** Adds a socket to its branch's room and returns the leave function. */
  join(branchId: string, socket: LiveSocket): () => void {
    const room = this.rooms.get(branchId) ?? new Set<LiveSocket>();
    room.add(socket);
    this.rooms.set(branchId, room);

    return () => {
      const current = this.rooms.get(branchId);
      if (!current) return;
      current.delete(socket);
      // Drop the empty Set rather than keeping it: otherwise a shop that has
      // been running for a month holds one entry per branch it ever saw.
      if (current.size === 0) this.rooms.delete(branchId);
    };
  }

  /**
   * Sends an event to every socket in one branch. Returns how many got it.
   *
   * A send that throws must not stop the others. A kitchen screen whose wifi
   * died half a second ago is a broken pipe, and it must not be able to stop
   * the till at the counter from being told the board changed.
   */
  broadcast(branchId: string, event: LiveEvent): number {
    const room = this.rooms.get(branchId);
    if (!room) return 0;

    const frame = JSON.stringify(event);
    let delivered = 0;

    for (const socket of room) {
      if (socket.readyState !== undefined && socket.readyState !== OPEN) continue;
      try {
        socket.send(frame);
        delivered += 1;
      } catch {
        // Presumed dead. The close handler removes it; forcing it out here as
        // well would mutate the Set we are iterating.
      }
    }

    return delivered;
  }

  /** Open sockets for a branch — used by the health endpoint and the tests. */
  countFor(branchId: string): number {
    return this.rooms.get(branchId)?.size ?? 0;
  }
}

/** The instance the routes use. */
export const liveHub = new LiveHub();
