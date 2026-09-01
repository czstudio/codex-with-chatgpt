(function () {
  "use strict";

  const MAX_BLOCK_BYTES = 4096;
  const TASK_SUMMARY_MAX_BYTES = 256;
  const INSTRUCTION_MAX_BYTES = 1024;
  const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
  const KEYS = [
    "VERSION",
    "TASK_ID",
    "WORKSPACE_ID",
    "OPERATION",
    "ATTEMPT",
    "ARM_ID",
    "IDEMPOTENCY_KEY",
    "TASK_SUMMARY",
    "INSTRUCTION",
    "APPROVAL_SUMMARY_HASH"
  ];
  const UNSAFE_APPROVAL_TEXT = [
    /(?:https?|file|ftp):\/\//i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\bbearer\s+\S+/i,
    /\b(?:bearer|api[_-]?key|access[_-]?key|password|secret|token|credential|cookie|session|private[_-]?key)\s*[:=]\s*\S+/i,
    /\bsk-[A-Za-z0-9_-]{12,}\b/i,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /(?:&&|\|\||[|;&`<>]|\$\(|\$\{)/,
    /(?:^|[\s"'])\b(?:sudo|su|rm|rmdir|del|format|mkfs|dd|curl|wget|nc|netcat|ssh|scp|chmod|chown|launchctl|powershell|pwsh|bash|sh|zsh|cmd(?:\.exe)?|docker|kubectl)\b/i,
    /\bgit\s+(?:push|reset|clean|checkout)\b/i,
    /\b(?:npm|pnpm|yarn|pip|uv)\s+install\b/i,
    /\b(?:ignore|disregard|override)\s+(?:the\s+)?(?:previous|system|developer|safety|local)?\s*instructions?\b/i,
    /\b(?:approval|sandbox|security)\s+(?:bypass|override)\b/i,
    /--(?:dangerously-)?(?:bypass|no-approval|no-sandbox)\b/i
  ];

  function safeApprovalText(value, maxBytes) {
    return typeof value === "string" && value.length > 0 && value.trim() === value &&
      new TextEncoder().encode(value).byteLength <= maxBytes &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      !UNSAFE_APPROVAL_TEXT.some((pattern) => pattern.test(value));
  }

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
    if (!safeApprovalText(values.TASK_SUMMARY, TASK_SUMMARY_MAX_BYTES) || !safeApprovalText(values.INSTRUCTION, INSTRUCTION_MAX_BYTES)) return null;
    if (!/^[a-f0-9]{64}$/.test(values.APPROVAL_SUMMARY_HASH)) return null;
    return {
      taskId: values.TASK_ID,
      workspaceId: values.WORKSPACE_ID,
      operation: values.OPERATION,
      attempt: 1,
      armId: values.ARM_ID,
      idempotencyKey: values.IDEMPOTENCY_KEY,
      taskSummary: values.TASK_SUMMARY,
      instruction: values.INSTRUCTION,
      approvalSummaryHash: values.APPROVAL_SUMMARY_HASH
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
    button.addEventListener("click", (event) => {
      button.disabled = true;
      button.textContent = "Sending…";
      const userActivated = event.isTrusted === true && Boolean(navigator.userActivation && navigator.userActivation.isActive);
      chrome.runtime.sendMessage({ type: "dispatchTask", block, userActivated }, (response) => {
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
    // ChatGPT may keep a fenced c2c-task in a pre > code block or render it
    // as a standalone code node. Every candidate still goes through the
    // complete task-block parser above, so ordinary inline code is ignored.
    document.querySelectorAll("code").forEach(attach);
  }

  scan();
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
}());
