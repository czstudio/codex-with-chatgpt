import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export const EXTENSION_SERVICE_NAME = "c2c-extension-bridge" as const;

export type ExtensionRuntimeState = {
  service: typeof EXTENSION_SERVICE_NAME;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  port: number;
  adminToken: string;
  startedAt: string;
};

export function extensionRuntimeFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "extension-runtime")), `${workspaceId}.json`);
}

export function writeExtensionRuntime(state: ExtensionRuntimeState): void {
  writeSecureJson(extensionRuntimeFile(state.workspaceId), state);
}

export function readExtensionRuntime(workspaceId: string): ExtensionRuntimeState | null {
  return readJsonIfExists<ExtensionRuntimeState>(extensionRuntimeFile(workspaceId));
}

export function clearExtensionRuntime(workspaceId: string): void {
  try {
    fs.rmSync(extensionRuntimeFile(workspaceId), { force: true });
  } catch {
    // Best effort during shutdown; stale runtime state is never trusted without
    // a live loopback admin probe.
  }
}
