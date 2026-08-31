import { describe, expect, it } from "vitest";
import { formatTaskBlock, parseTaskBlock, TaskBlockError } from "../src/extension/task-block.js";

const valid = {
  taskId: "c2c_task_a",
  workspaceId: "0123456789ab",
  operation: "codex_turn" as const,
  attempt: 1 as const,
  armId: "arm_a",
  idempotencyKey: "idem_a",
};

describe("strict C2C task blocks", () => {
  it("formats and parses the canonical block, including one exact code fence", () => {
    const block = formatTaskBlock(valid);
    expect(parseTaskBlock(block)).toEqual(valid);
    expect(parseTaskBlock(`\`\`\`c2c-task\n${block}\n\`\`\``)).toEqual(valid);
  });

  it("rejects unknown fields, duplicate fields, arbitrary operations and stale attempts", () => {
    const block = formatTaskBlock(valid);
    expect(() => parseTaskBlock(block.replace("IDEMPOTENCY_KEY: idem_a", "PROMPT: run rm -rf\nIDEMPOTENCY_KEY: idem_a"))).toThrow(
      TaskBlockError
    );
    expect(() => parseTaskBlock(block.replace("ARM_ID: arm_a", "ARM_ID: arm_a\nARM_ID: arm_b"))).toThrow(TaskBlockError);
    expect(() => parseTaskBlock(block.replace("OPERATION: codex_turn", "OPERATION: arbitrary_shell"))).toThrow(/OPERATION_NOT_ALLOWED/);
    expect(() => parseTaskBlock(block.replace("ATTEMPT: 1", "ATTEMPT: 2"))).toThrow(/ATTEMPT_INVALID/);
    expect(() => parseTaskBlock(`${block}\nEXTRA: nope`)).toThrow(TaskBlockError);
  });

  it("rejects URLs, prompt text and oversized input", () => {
    const block = formatTaskBlock(valid);
    expect(() => parseTaskBlock(block.replace("TASK_ID: c2c_task_a", "TASK_ID: https://example.invalid"))).toThrow(TaskBlockError);
    expect(() => parseTaskBlock(block.replace("TASK_ID: c2c_task_a", "TASK_ID: c2c_task_a\nPROMPT: do work"))).toThrow(TaskBlockError);
    expect(() => parseTaskBlock(`${block}${"x".repeat(4_000)}`)).toThrow(/BLOCK_TOO_LARGE/);
  });
});
