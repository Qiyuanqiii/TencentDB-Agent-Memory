import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";

const tempDirs: string[] = [];

async function makeCheckpoint(): Promise<CheckpointManager> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-counter-repair-"));
  tempDirs.push(dir);
  return new CheckpointManager(dir);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("CheckpointManager counter regression repair", () => {
  it("raises only regressed counters to the supplied baseline", async () => {
    const checkpoint = await makeCheckpoint();
    await checkpoint.setPersonaUpdateRequest("keep this request");
    const current = await checkpoint.read();
    await checkpoint.write({
      ...current,
      scenes_processed: 1,
      total_processed: 2,
      memories_since_last_persona: 3,
    });

    await checkpoint.repairRegressedCounters({
      scenes_processed: 4,
      total_processed: 5,
      memories_since_last_persona: 6,
    });

    const repaired = await checkpoint.read();
    expect(repaired.scenes_processed).toBe(4);
    expect(repaired.total_processed).toBe(5);
    expect(repaired.memories_since_last_persona).toBe(6);
    expect(repaired.request_persona_update).toBe(true);
    expect(repaired.persona_update_reason).toBe("keep this request");
  });

  it("preserves progress that arrives after regression detection", async () => {
    const checkpoint = await makeCheckpoint();
    await checkpoint.captureAtomically("baseline", undefined, async () => ({
      maxTimestamp: 100,
      messageCount: 5,
    }));
    await checkpoint.markL1ExtractionComplete("baseline", 3);
    await checkpoint.incrementScenesProcessed();
    const baseline = await checkpoint.read();

    // Simulate the regressed checkpoint that L2's defensive repair detects.
    await checkpoint.write({
      ...baseline,
      scenes_processed: 0,
      total_processed: 1,
      memories_since_last_persona: 0,
    });
    const stalePostState = await checkpoint.read();
    expect(stalePostState.total_processed).toBe(1);

    // Another session advances while L2 is preparing its repair.
    await checkpoint.captureAtomically("during-repair", undefined, async () => ({
      maxTimestamp: 200,
      messageCount: 10,
    }));
    await checkpoint.markL1ExtractionComplete("during-repair", 6);
    await checkpoint.incrementScenesProcessed();
    await checkpoint.incrementScenesProcessed();

    await checkpoint.repairRegressedCounters({
      scenes_processed: baseline.scenes_processed,
      total_processed: baseline.total_processed,
      memories_since_last_persona: baseline.memories_since_last_persona,
    });

    const repaired = await checkpoint.read();
    expect(repaired.total_processed).toBe(11);
    expect(repaired.l0_conversations_count).toBe(2);
    expect(repaired.total_memories_extracted).toBe(9);
    expect(repaired.memories_since_last_persona).toBe(6);
    expect(repaired.scenes_processed).toBe(2);
    expect(repaired.runner_states["during-repair"].last_captured_timestamp).toBe(200);
    expect(repaired.runner_states["during-repair"].last_l1_cursor).toBe(0);
  });
});
