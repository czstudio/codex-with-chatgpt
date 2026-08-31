"use strict";

const portInput = document.getElementById("port");
const nonceInput = document.getElementById("nonce");
const message = document.getElementById("message");

chrome.storage.local.get(["port"], (settings) => {
  if (settings.port) portInput.value = String(settings.port);
});

document.getElementById("save").addEventListener("click", () => {
  const port = Number(portInput.value);
  const nonce = nonceInput.value.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9._-]{32,}$/.test(nonce)) {
    message.textContent = "Enter a valid port and one-time nonce.";
    return;
  }
  chrome.storage.local.set({ port, nonce }, () => {
    message.textContent = "Saved. The nonce will be removed after one handoff.";
    nonceInput.value = "";
  });
});
