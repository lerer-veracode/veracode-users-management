import { randomBytes } from "node:crypto";
import type { Session } from "./vault/vault.js";

export const IDLE_MS = 30 * 60 * 1000;

export type ActiveSession = {
  id: string;
  vault: Session;
  lastSeen: number;
  activeConnectionId: string | null;
};

export class Sessions {
  private readonly active = new Map<string, ActiveSession>();

  create(vault: Session, now: number, activeConnectionId: string | null): ActiveSession {
    const session = {
      id: randomBytes(32).toString("base64url"),
      vault,
      lastSeen: now,
      activeConnectionId,
    };
    this.active.set(session.id, session);
    return session;
  }

  get(id: string | undefined, now: number): ActiveSession | null {
    const session = id ? this.active.get(id) : undefined;
    if (!session) return null;
    if (now - session.lastSeen > IDLE_MS) {
      this.active.delete(session.id);
      return null;
    }
    session.lastSeen = now;
    return session;
  }

  delete(id: string | undefined): void {
    if (id) this.active.delete(id);
  }

  all(): ActiveSession[] {
    return [...this.active.values()];
  }
}

const MAX_DELAY_MS = 8000;

export class Throttle {
  private readonly failures = new Map<string, number>();

  delayFor(username: string): number {
    const n = this.failures.get(username) ?? 0;
    return n === 0 ? 0 : Math.min(250 * 2 ** n, MAX_DELAY_MS);
  }

  fail(username: string): void {
    this.failures.set(username, (this.failures.get(username) ?? 0) + 1);
  }

  succeed(username: string): void {
    this.failures.delete(username);
  }
}
