"use strict";

const NONCE_PATTERN = /^[A-Za-z0-9._-]{32,}$/;
const BRIDGE_URL = "http://127.0.0.1:62141";

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
  if (message.userActivated !== true) {
    sendResponse({ ok: false, error: "USER_ACTIVATION_REQUIRED" });
    return false;
  }

  (async () => {
    const extensionId = chrome.runtime.id;
    try {
      // Pair only after a real click from the strict-task content script. The
      // bridge binds the returned nonce to this extension origin and consumes
      // it on the following dispatch; it is never stored in extension state.
      const pairResponse = await fetch(`${BRIDGE_URL}/v1/task/pair`, {
        method: "POST",
        headers: {
          "x-c2c-extension-id": extensionId,
          "x-c2c-user-activation": "1"
        }
      });
      const pairBody = await pairResponse.json().catch(() => null);
      const nonce = pairBody && typeof pairBody.nonce === "string" ? pairBody.nonce : "";
      if (!pairResponse.ok) {
        sendResponse({ ok: false, error: safeError(pairBody) });
        return;
      }
      if (!NONCE_PATTERN.test(nonce)) {
        sendResponse({ ok: false, error: "INVALID_PAIRING" });
        return;
      }
      const response = await fetch(`${BRIDGE_URL}/v1/task/dispatch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${nonce}`,
          "x-c2c-extension-id": extensionId
        },
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
    }
  })();
  return true;
});
