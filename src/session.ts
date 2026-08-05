import type { SessionPhase, SessionState } from "./types.js";
import { SESSION_MAP_MAX_SIZE } from "./constants.js";
import { logDebug } from "./logger.js";

const VALID_TRANSITIONS: Record<SessionPhase, SessionPhase[]> = {
  idle: ["active"],
  active: ["failing", "retrying", "idle"],
  failing: ["retrying", "idle"],
  retrying: ["active", "idle"],
};

function createDefaultState(isSubagent: boolean): SessionState {
  return {
    isSubagent,
    phase: "idle",
    chainIndex: 0,
    rateLimitCount: 0,
    serverErrorCount: 0,
    currentModelId: undefined,
    lastUserMessageID: undefined,
    lastFailedModelId: undefined,
    retryAttempt: 0,
    fallbacksTriggered: 0,
    lastErrorFingerprint: undefined,
    lastErrorAt: 0,
    createdAt: Date.now(),
    markedForDeletion: false,
  };
}

/** Manages per-session fallback state with a phase-based state machine. */
export class SessionManager {
  private sessions = new Map<string, SessionState>();

  /** Returns session count. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Returns existing session or creates one. Resolves isSubagent via the provided
   * async function on first call only. Subsequent calls return the cached session.
   */
  async getOrCreate(
    sessionID: string,
    resolveSubagent: () => Promise<boolean>,
  ): Promise<SessionState> {
    const existing = this.sessions.get(sessionID);
    if (existing) return existing;

    this.prune();

    let isSubagent = false;
    try {
      isSubagent = await resolveSubagent();
    } catch {
      // Default to non-subagent on resolution failure.
    }

    // Check again after await — another caller may have created it
    const check = this.sessions.get(sessionID);
    if (check) return check;

    const state = createDefaultState(isSubagent);
    this.sessions.set(sessionID, state);
    return state;
  }

  /** Returns the session if it exists. Does not allocate on miss. */
  getIfExists(sessionID: string): SessionState | undefined {
    return this.sessions.get(sessionID);
  }

  /**
   * Validates and applies a phase transition. Returns true if the transition
   * was valid and applied. Returns false on invalid transitions (phase unchanged).
   * Transitions to idle/active trigger deferred deletion cleanup.
   */
  setPhase(sessionID: string, target: SessionPhase): boolean {
    const session = this.sessions.get(sessionID);
    if (!session) return false;

    // any→idle is always valid
    if (target !== "idle") {
      const allowed = VALID_TRANSITIONS[session.phase];
      if (!allowed.includes(target)) {
        logDebug(
          `invalid transition ${session.phase}→${target} for ${sessionID}`,
        );
        return false;
      }
    }

    session.phase = target;

    // Deferred deletion: clean up if marked and now in a safe phase
    if (
      (target === "idle" || target === "active") &&
      session.markedForDeletion
    ) {
      this.sessions.delete(sessionID);
    }

    return true;
  }

  /**
   * Deletes a session. If the session is in "retrying" phase, sets markedForDeletion
   * instead — actual removal deferred until phase transitions to idle/active.
   */
  delete(sessionID: string): void {
    const session = this.sessions.get(sessionID);
    if (!session) return;

    if (session.phase === "retrying") {
      session.markedForDeletion = true;
      return;
    }

    this.sessions.delete(sessionID);
  }

  /** Evicts oldest idle sessions if map exceeds capacity. Skips non-idle sessions. */
  prune(): void {
    if (this.sessions.size <= SESSION_MAP_MAX_SIZE) return;

    const idle: [string, SessionState][] = [];
    for (const [id, s] of this.sessions) {
      if (s.phase === "idle") idle.push([id, s]);
    }

    // Sort by createdAt ascending (oldest first)
    idle.sort((a, b) => a[1].createdAt - b[1].createdAt);

    const toEvict = this.sessions.size - SESSION_MAP_MAX_SIZE;
    for (let i = 0; i < Math.min(toEvict, idle.length); i++) {
      this.sessions.delete(idle[i][0]);
    }
  }
}
