(function () {
  "use strict";

  const MAX_BLOCK_BYTES = 2048;
  const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
  const KEYS = ["VERSION", "TASK_ID", "WORKSPACE_ID", "OPERATION", "ATTEMPT", "ARM_ID", "IDEMPOTENCY_KEY"];

  function parseTaskBlock(value) {
    if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_BLOCK_BYTES) return null;
    const trimmed = value.replace(/\r\n/g, "\n").trim();
    let body = trimmed;
    if (trimmed.startsWith("```")) {
      const match = /^```c2c-task\n([\s\S]*?)\n```$/.exec(trimmed);
      if (!match) return null;
      body = match[1];
    }
    const lines = body.split("\n");
    if (lines.length !== KEYS.length + 2 || lines[0] !== "[C2C_TASK]" || lines[lines.length - 1] !== "[/C2C_TASK]") return null;
    const values = {};
    for (let i = 0; i < KEYS.length; i += 1) {
      const match = /^([A-Z_]+): ([^\r\n]+)$/.exec(lines[i + 1]);
      if (!match || match[1] !== KEYS[i] || Object.prototype.hasOwnProperty.call(values, match[1])) return null;
      values[match[1]] = match[2];
    }
    if (values.VERSION !== "1" || values.OPERATION !== "codex_turn" || values.ATTEMPT !== "1") return null;
    if (![values.TASK_ID, values.WORKSPACE_ID, values.ARM_ID, values.IDEMPOTENCY_KEY].every((id) => SAFE_ID.test(id))) return null;
    return {
      taskId: values.TASK_ID,
      workspaceId: values.WORKSPACE_ID,
      operation: values.OPERATION,
      attempt: 1,
      armId: values.ARM_ID,
      idempotencyKey: values.IDEMPOTENCY_KEY
    };
  }

  function renderResult(result) {
    const fields = [
      ["status", result.status],
      ["exitStatus", result.exitStatus],
      ["taskId", result.taskId],
      ["tests", result.tests],
      ["changedFilesCount", result.changedFilesCount],
      ["notes", result.notes]
    ];
    return fields.filter((entry) => entry[1] !== undefined && entry[1] !== null && entry[1] !== "")
      .map((entry) => `${entry[0]}: ${String(entry[1]).slice(0, 200)}`)
      .join("\n");
  }

  function attach(code) {
    if (code.dataset.c2cHandoffAttached === "1") return;
    const block = code.textContent || "";
    if (!parseTaskBlock(block)) return;
    const parent = code.closest("pre") || code.parentElement;
    if (!parent || parent.dataset.c2cHandoffAttached === "1") return;
    parent.dataset.c2cHandoffAttached = "1";
    code.dataset.c2cHandoffAttached = "1";
    const controls = document.createElement("div");
    controls.dataset.c2cHandoff = "1";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Send to local Codex";
    button.addEventListener("click", () => {
      button.disabled = true;
      button.textContent = "Sending…";
      chrome.runtime.sendMessage({ type: "dispatchTask", block }, (response) => {
        const error = chrome.runtime.lastError;
        const result = document.createElement("pre");
        result.dataset.c2cResult = "1";
        result.textContent = error ? "BRIDGE_UNAVAILABLE" : response && response.ok ? renderResult(response.result) : String(response && response.error || "DISPATCH_FAILED").slice(0, 200);
        controls.appendChild(result);
        button.textContent = response && response.ok ? "Sent" : "Send to local Codex";
        button.disabled = Boolean(response && response.ok);
      });
    });
    controls.appendChild(button);
    parent.insertAdjacentElement("afterend", controls);
  }

  function scan() {
    document.querySelectorAll("pre code").forEach(attach);
  }

  scan();
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
}());
