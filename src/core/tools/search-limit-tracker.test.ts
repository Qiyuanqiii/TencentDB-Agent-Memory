import { describe, it, expect, vi } from "vitest";
import {
  SearchLimitTracker,
  MAX_SEARCH_CALLS_PER_TURN,
  SEARCH_LIMIT_EXCEEDED_MESSAGE,
} from "./search-limit-tracker.js";

describe("SearchLimitTracker (方案 D)", () => {
  it("allows calls up to MAX_SEARCH_CALLS_PER_TURN (3 calls) and strictly rejects 4th call", () => {
    const tracker = new SearchLimitTracker();
    const sessionKey = "session-test-1";

    // 1st call — allowed
    const res1 = tracker.recordCall(sessionKey, "call-1");
    expect(res1.allowed).toBe(true);
    expect(res1.count).toBe(1);
    const dec1 = tracker.consumeDecision("call-1", sessionKey);
    expect(dec1?.allowed).toBe(true);

    // 2nd call — allowed
    const res2 = tracker.recordCall(sessionKey, "call-2");
    expect(res2.allowed).toBe(true);
    expect(res2.count).toBe(2);
    const dec2 = tracker.consumeDecision("call-2", sessionKey);
    expect(dec2?.allowed).toBe(true);

    // 3rd call — MUST be allowed (critical regression test: off-by-one verification)
    const res3 = tracker.recordCall(sessionKey, "call-3");
    expect(res3.allowed).toBe(true);
    expect(res3.count).toBe(3);
    const dec3 = tracker.consumeDecision("call-3", sessionKey);
    expect(dec3).toBeDefined();
    expect(dec3?.allowed).toBe(true);
    expect(dec3?.count).toBe(3);

    // 4th call — strictly rejected
    const res4 = tracker.recordCall(sessionKey, "call-4");
    expect(res4.allowed).toBe(false);
    expect(res4.count).toBe(4);
    const dec4 = tracker.consumeDecision("call-4", sessionKey);
    expect(dec4).toBeDefined();
    expect(dec4?.allowed).toBe(false);
    expect(dec4?.count).toBe(4);

    // 5th call — strictly rejected
    const res5 = tracker.recordCall(sessionKey, "call-5");
    expect(res5.allowed).toBe(false);
    expect(res5.count).toBe(5);
  });

  it("handles duplicate hook triggers for the same toolCallId idempotently (no double counting)", () => {
    const tracker = new SearchLimitTracker();
    const sessionKey = "session-idempotent";

    // Call 1 triggered twice by hook
    const firstTrigger = tracker.recordCall(sessionKey, "call-dup-1");
    expect(firstTrigger.count).toBe(1);
    expect(firstTrigger.allowed).toBe(true);

    const secondTrigger = tracker.recordCall(sessionKey, "call-dup-1");
    expect(secondTrigger.count).toBe(1);
    expect(secondTrigger.allowed).toBe(true);

    // Verify session count is still 1, not 2
    expect(tracker.getCount(sessionKey)).toBe(1);

    // Call 2
    tracker.recordCall(sessionKey, "call-dup-2");
    expect(tracker.getCount(sessionKey)).toBe(2);

    // Call 3
    tracker.recordCall(sessionKey, "call-dup-3");
    expect(tracker.getCount(sessionKey)).toBe(3);

    // Call 3 triggered again
    const call3Retry = tracker.recordCall(sessionKey, "call-dup-3");
    expect(call3Retry.count).toBe(3);
    expect(call3Retry.allowed).toBe(true);
    expect(tracker.getCount(sessionKey)).toBe(3);
  });

  it("isolates counters across different sessions without crosstalk", () => {
    const tracker = new SearchLimitTracker();
    const sessionA = "session-a";
    const sessionB = "session-b";

    tracker.recordCall(sessionA, "a-1");
    tracker.recordCall(sessionA, "a-2");
    tracker.recordCall(sessionA, "a-3");
    const a4 = tracker.recordCall(sessionA, "a-4");
    expect(a4.allowed).toBe(false);
    expect(tracker.isLimitReached(sessionA)).toBe(true);

    // sessionB should be completely unaffected
    expect(tracker.isLimitReached(sessionB)).toBe(false);
    const b1 = tracker.recordCall(sessionB, "b-1");
    expect(b1.allowed).toBe(true);
    expect(b1.count).toBe(1);
  });

  it("does not cross-talk or lock other sessions when hook is missing sessionKey", () => {
    const tracker = new SearchLimitTracker();
    const sessionA = "session-legit-a";

    // Call with missing sessionKey (undefined)
    const anonCall1 = tracker.recordCall(undefined, "anon-1");
    expect(anonCall1.allowed).toBe(true);

    const anonCall2 = tracker.recordCall(undefined, "anon-2");
    expect(anonCall2.allowed).toBe(true);

    const anonCall3 = tracker.recordCall(undefined, "anon-3");
    expect(anonCall3.allowed).toBe(true);

    const anonCall4 = tracker.recordCall(undefined, "anon-4");
    expect(anonCall4.allowed).toBe(true);

    // Legit session has 0 calls recorded and is not blocked by anonymous calls
    expect(tracker.getCount(sessionA)).toBe(0);
    expect(tracker.isLimitReached(sessionA)).toBe(false);

    const a1 = tracker.recordCall(sessionA, "a-1");
    expect(a1.allowed).toBe(true);
    expect(a1.count).toBe(1);
  });

  it("enforces hard limit even when hook is missing toolCallId (does not silently lose limit)", () => {
    const tracker = new SearchLimitTracker();
    const sessionKey = "session-no-tool-call-id";

    // 3 calls without toolCallId in hook
    const c1 = tracker.recordCall(sessionKey, undefined);
    expect(c1.allowed).toBe(true);
    expect(c1.count).toBe(1);

    const c2 = tracker.recordCall(sessionKey, undefined);
    expect(c2.allowed).toBe(true);
    expect(c2.count).toBe(2);

    const c3 = tracker.recordCall(sessionKey, undefined);
    expect(c3.allowed).toBe(true);
    expect(c3.count).toBe(3);

    // 4th call without toolCallId — must be rejected
    const c4 = tracker.recordCall(sessionKey, undefined);
    expect(c4.allowed).toBe(false);
    expect(c4.count).toBe(4);

    // Verify execute() consumes the queued decisions sequentially
    const exec1 = tracker.consumeDecision("exec-id-1", sessionKey);
    expect(exec1?.allowed).toBe(true);
    expect(exec1?.count).toBe(1);

    const exec2 = tracker.consumeDecision("exec-id-2", sessionKey);
    expect(exec2?.allowed).toBe(true);
    expect(exec2?.count).toBe(2);

    const exec3 = tracker.consumeDecision("exec-id-3", sessionKey);
    expect(exec3?.allowed).toBe(true);
    expect(exec3?.count).toBe(3);

    const exec4 = tracker.consumeDecision("exec-id-4", sessionKey);
    expect(exec4?.allowed).toBe(false);
    expect(exec4?.count).toBe(4);
  });

  it("shares the 3-call budget when memory search and conversation search are interleaved", () => {
    const tracker = new SearchLimitTracker();
    const sessionKey = "session-interleaved";

    // Call 1: tdai_memory_search
    const call1 = tracker.recordCall(sessionKey, "mem-call-1");
    expect(call1.allowed).toBe(true);
    expect(call1.count).toBe(1);
    expect(tracker.consumeDecision("mem-call-1", sessionKey)?.allowed).toBe(true);

    // Call 2: tdai_conversation_search
    const call2 = tracker.recordCall(sessionKey, "conv-call-1");
    expect(call2.allowed).toBe(true);
    expect(call2.count).toBe(2);
    expect(tracker.consumeDecision("conv-call-1", sessionKey)?.allowed).toBe(true);

    // Call 3: tdai_memory_search (3rd total attempt)
    const call3 = tracker.recordCall(sessionKey, "mem-call-2");
    expect(call3.allowed).toBe(true);
    expect(call3.count).toBe(3);
    expect(tracker.consumeDecision("mem-call-2", sessionKey)?.allowed).toBe(true);

    // Call 4: tdai_conversation_search (4th total attempt — exceeded)
    const call4 = tracker.recordCall(sessionKey, "conv-call-2");
    expect(call4.allowed).toBe(false);
    expect(call4.count).toBe(4);
    expect(tracker.consumeDecision("conv-call-2", sessionKey)?.allowed).toBe(false);
  });

  it("resets counter on new turn (`before_prompt_build`)", () => {
    const tracker = new SearchLimitTracker();
    const sessionKey = "session-turn-reset";

    tracker.recordCall(sessionKey, "turn1-1");
    tracker.recordCall(sessionKey, "turn1-2");
    tracker.recordCall(sessionKey, "turn1-3");
    expect(tracker.recordCall(sessionKey, "turn1-4").allowed).toBe(false);

    // New turn begins (before_prompt_build)
    tracker.resetTurn(sessionKey);
    expect(tracker.getCount(sessionKey)).toBe(0);
    expect(tracker.isLimitReached(sessionKey)).toBe(false);

    // First call of turn 2 should pass
    const turn2_1 = tracker.recordCall(sessionKey, "turn2-1");
    expect(turn2_1.allowed).toBe(true);
    expect(turn2_1.count).toBe(1);
  });

  it("clears session counter at agent_end (even on failed agent turns)", () => {
    const tracker = new SearchLimitTracker();
    const sessionKey = "session-clear-failure";

    tracker.recordCall(sessionKey, "call-1");
    tracker.recordCall(sessionKey, "call-2");
    expect(tracker.getCount(sessionKey)).toBe(2);

    // Agent turn fails or ends
    tracker.clearSession(sessionKey);
    expect(tracker.getCount(sessionKey)).toBe(0);

    // Subsequent turn starts with empty quota
    const nextCall = tracker.recordCall(sessionKey, "call-next-1");
    expect(nextCall.allowed).toBe(true);
    expect(nextCall.count).toBe(1);
  });

  it("provides direct fallback when hook is bypassed and sessionKey is provided", () => {
    const tracker = new SearchLimitTracker();
    const sessionKey = "session-fallback-direct";

    // Simulate hook bypassed: consumeDecision returns undefined
    expect(tracker.consumeDecision("unhooked-1", sessionKey)).toBeUndefined();

    // Direct execute fallback invokes recordCall
    const fb1 = tracker.recordCall(sessionKey, "unhooked-1");
    expect(fb1.allowed).toBe(true);
    expect(fb1.count).toBe(1);

    const fb2 = tracker.recordCall(sessionKey, "unhooked-2");
    expect(fb2.allowed).toBe(true);
    expect(fb2.count).toBe(2);

    const fb3 = tracker.recordCall(sessionKey, "unhooked-3");
    expect(fb3.allowed).toBe(true);
    expect(fb3.count).toBe(3);

    const fb4 = tracker.recordCall(sessionKey, "unhooked-4");
    expect(fb4.allowed).toBe(false);
    expect(fb4.count).toBe(4);
  });

  it("properly respects AbortSignal parameter without crashing or misinterpreting", () => {
    const tracker = new SearchLimitTracker();
    const sessionKey = "session-abort-signal";
    const controller = new AbortController();

    tracker.recordCall(sessionKey, "signal-call-1");
    const decision = tracker.consumeDecision("signal-call-1", sessionKey);

    // Simulate OpenClaw execute(toolCallId, params, signal)
    const executeMock = (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect((signal as any).sessionKey).toBeUndefined();
      const dec = tracker.consumeDecision(toolCallId, sessionKey);
      if (dec && !dec.allowed) {
        return { limitReached: true, text: SEARCH_LIMIT_EXCEEDED_MESSAGE };
      }
      return { limitReached: false, text: "ok" };
    };

    const res = executeMock("signal-call-1", { query: "test" }, controller.signal);
    expect(res.limitReached).toBe(false);
  });

  it("sweeps expired TTL entries", () => {
    const tracker = new SearchLimitTracker();
    const sessionKey = "session-ttl";

    tracker.recordCall(sessionKey, "call-1");
    tracker.recordCall(sessionKey, "call-2");
    tracker.recordCall(sessionKey, "call-3");
    tracker.recordCall(sessionKey, "call-4");

    // Fast-forward time past 10 minutes
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 15 * 60 * 1000);

    tracker.sweep(10 * 60 * 1000);
    expect(tracker.getCount(sessionKey)).toBe(0);
    expect(tracker.consumeDecision("call-4", sessionKey)).toBeUndefined();

    vi.restoreAllMocks();
  });
});
