"use strict";

const NONCE_PATTERN = /^[A-Za-z0-9._-]{32,}$/;

function safeResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.ok !== true) return null;
  const allowed = ["ok", "authority", "workspaceId", "taskId", "operation", "armId", "attempt", "dispatchId", "resultReceiptId", "status", "exitStatus", "tests", "changedFilesCount", "notes"];
  const result = {};
  for (const key of allowed) {
    if (value[key] !== undefined && value[key] !== null) {
      result[key] = typeof value[key] === "string" ? value[key].slice(0, 200) : value[key];
    }
  }
  return result;
}

function safeError(value) {
  if (!value || typeof value !== "object" || typeof value.error !== "string") return "DISPATCH_FAILED";
  return value.error.slice(0, 80);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "dispatchTask" || typeof message.block !== "string") return false;
  if (!sender.url || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.url)) {
    sendResponse({ ok: false, error: "SENDER_NOT_ALLOWED" });
    return false;
  }

  chrome.storage.local.get(["port", "nonce"], async (settings) => {
    const port = Number(settings.port);
    const nonce = typeof settings.nonce === "string" ? settings.nonce : "";
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !NONCE_PATTERN.test(nonce)) {
      sendResponse({ ok: false, error: "BRIDGE_NOT_CONFIGURED" });
      return;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/task/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${nonce}` },
        body: JSON.stringify({ block: message.block })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        sendResponse({ ok: false, error: safeError(body) });
        return;
      }
      const result = safeResult(body);
      sendResponse(result ? { ok: true, result } : { ok: false, error: "INVALID_BRIDGE_RESULT" });
    } catch {
      sendResponse({ ok: false, error: "BRIDGE_UNAVAILABLE" });
    } finally {
      // A nonce is one-use. Clear it even when the network outcome is
      // ambiguous; retry requires a fresh explicit CLI read.
      await chrome.storage.local.remove("nonce");
    }
  });
  return true;
});
