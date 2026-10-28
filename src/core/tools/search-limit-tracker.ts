/**
 * Hard per-turn call limit tracker for memory search tools (方案 D).
 *
 * Enforces a combined limit across `tdai_memory_search` and `tdai_conversation_search`
 * (default: 3 calls per turn, matching the tool description and MEMORY_TOOLS_GUIDE).
 */

export const MAX_SEARCH_CALLS_PER_TURN = 3;

export const SEARCH_LIMIT_EXCEEDED_MESSAGE =
  "Search limit reached (maximum 3 calls per turn combined for tdai_memory_search and tdai_conversation_search). Stop searching and reply to the user using the information gathered so far.";

export interface ToolCallDecision {
  allowed: boolean;
  count: number;
  sessionKey?: string;
  ts: number;
}

// Backwards-compatible alias
export type ExceededCallInfo = ToolCallDecision;

interface SessionState {
  count: number;
  ts: number;
  pendingDecisions: ToolCallDecision[];
}

export class SearchLimitTracker {
  private readonly maxCalls: number;
  private readonly sessions = new Map<string, SessionState>();
  private readonly decisions = new Map<string, ToolCallDecision>();

  constructor(maxCalls = MAX_SEARCH_CALLS_PER_TURN) {
    this.maxCalls = maxCalls;
  }

  /**
   * Record a tool call attempt.
   * Invoked from `before_tool_call` hook or execute fallback.
   *
   * - If toolCallId was already recorded in this turn (duplicate hook trigger),
   *   returns the existing decision without double counting.
   * - If sessionKey is missing/unresolvable, grants allowed=true without polluting
   *   a global shared bucket.
   * - If toolCallId is omitted, queues the decision in session pending queue.
   */
  recordCall(sessionKey?: string, toolCallId?: string): ToolCallDecision {
    const now = Date.now();

    // Idempotency: avoid double-counting if the same toolCallId triggers hook repeatedly
    if (toolCallId && this.decisions.has(toolCallId)) {
      return this.decisions.get(toolCallId)!;
    }

    // Missing session key: do not cross-talk or lock other sessions
    if (!sessionKey) {
      const decision: ToolCallDecision = {
        allowed: true,
        count: 0,
        sessionKey: undefined,
        ts: now,
      };
      if (toolCallId) {
        this.decisions.set(toolCallId, decision);
      }
      return decision;
    }

    let state = this.sessions.get(sessionKey);
    if (!state) {
      state = { count: 0, ts: now, pendingDecisions: [] };
      this.sessions.set(sessionKey, state);
    }

    state.count += 1;
    state.ts = now;
    const allowed = state.count <= this.maxCalls;

    const decision: ToolCallDecision = {
      allowed,
      count: state.count,
      sessionKey,
      ts: now,
    };

    if (toolCallId) {
      this.decisions.set(toolCallId, decision);
    } else {
      // Hook fired without toolCallId; queue for upcoming execute()
      state.pendingDecisions.push(decision);
    }

    return decision;
  }

  /**
   * Consume the decision for a given toolCallId or fallback sessionKey.
   * Invoked from tool `execute()` to determine if early-return is needed.
   */
  consumeDecision(toolCallId?: string, sessionKey?: string): ToolCallDecision | undefined {
    if (toolCallId && this.decisions.has(toolCallId)) {
      const decision = this.decisions.get(toolCallId)!;
      this.decisions.delete(toolCallId);
      return decision;
    }

    if (sessionKey) {
      const state = this.sessions.get(sessionKey);
      if (state && state.pendingDecisions.length > 0) {
        return state.pendingDecisions.shift();
      }
    }

    return undefined;
  }

  /**
   * Backwards-compatible helper: checks if a call exceeded the limit.
   */
  consumeExceeded(toolCallId: string): ToolCallDecision | undefined {
    const dec = this.consumeDecision(toolCallId);
    if (dec && !dec.allowed) {
      return dec;
    }
    return undefined;
  }

  /**
   * Query if a session has already reached the maximum allowed calls in the current turn.
   */
  isLimitReached(sessionKey?: string): boolean {
    if (!sessionKey) return false;
    const count = this.sessions.get(sessionKey)?.count ?? 0;
    return count >= this.maxCalls;
  }

  /**
   * Check if a session has reached its limit (alias for compatibility).
   */
  isSessionLimitReached(sessionKey: string): boolean {
    return this.isLimitReached(sessionKey);
  }

  /**
   * Reset call counter for a session at the start of a turn (`before_prompt_build`).
   */
  resetTurn(sessionKey?: string): void {
    if (!sessionKey) return;
    const state = this.sessions.get(sessionKey);
    if (state) {
      state.count = 0;
      state.ts = Date.now();
      state.pendingDecisions = [];
    } else {
      this.sessions.set(sessionKey, { count: 0, ts: Date.now(), pendingDecisions: [] });
    }
  }

  /**
   * Clear session state at turn completion (`agent_end`).
   */
  clearSession(sessionKey?: string): void {
    if (!sessionKey) return;
    this.sessions.delete(sessionKey);
  }

  /**
   * Get current call count for a session in the current turn.
   */
  getCount(sessionKey?: string): number {
    if (!sessionKey) return 0;
    return this.sessions.get(sessionKey)?.count ?? 0;
  }

  /**
   * Evict stale entries past TTL or when map exceeds max capacity.
   */
  sweep(ttlMs: number, maxCapacity = 10_000): void {
    const now = Date.now();
    for (const [key, entry] of this.sessions) {
      if (now - entry.ts > ttlMs) {
        this.sessions.delete(key);
      }
    }
    for (const [key, entry] of this.decisions) {
      if (now - entry.ts > ttlMs) {
        this.decisions.delete(key);
      }
    }

    if (this.sessions.size > maxCapacity) {
      const sorted = [...this.sessions.entries()].sort((a, b) => a[1].ts - b[1].ts);
      const toEvict = sorted.slice(0, sorted.length - maxCapacity);
      for (const [key] of toEvict) {
        this.sessions.delete(key);
      }
    }

    if (this.decisions.size > maxCapacity) {
      const sorted = [...this.decisions.entries()].sort((a, b) => a[1].ts - b[1].ts);
      const toEvict = sorted.slice(0, sorted.length - maxCapacity);
      for (const [key] of toEvict) {
        this.decisions.delete(key);
      }
    }
  }
}
