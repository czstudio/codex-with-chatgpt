import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CodexCliInvoker } from "../inbox/codex-invoker.js";
import { TaskDispatcher, type CodexTurnInvoker } from "../inbox/task-dispatcher.js";
import { TaskInboxError } from "../inbox/task-inbox.js";
import { Workspace } from "../workspace/manager.js";
import { DEFAULT_HOST } from "../config/paths.js";
import { VERSION } from "../version.js";
import { TaskBlockError, parseTaskBlock } from "./task-block.js";
import { clearExtensionRuntime, writeExtensionRuntime, type ExtensionRuntimeState } from "./runtime.js";

const MAX_JSON_BYTES = "8kb";
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-z0-9_-]+$/i;

export type ExtensionBridgeOptions = {
  workspaceRoot: string;
  port?: number;
  host?: string;
  dispatcher?: TaskDispatcher;
  invoke?: CodexTurnInvoker;
  /** Persist only loopback runtime metadata and an admin token, never the nonce. */
  persistRuntime?: boolean;
  /** Test seam; production callers should let the bridge generate a nonce. */
  nonce?: string;
};

export type ExtensionDispatchResponse = {
  ok: true;
  authority: "local-task-inbox";
  workspaceId: string;
  taskId: string;
  operation: "codex_turn";
  armId: string;
  attempt: 1;
  dispatchId: string;
  resultReceiptId: string;
  status: "SUCCEEDED" | "FAILED" | "BLOCKED";
  exitStatus: "ok" | "failed" | "blocked";
  tests: string | null;
  changedFilesCount: number;
  notes?: string;
};

export interface ExtensionBridge {
  workspace: Workspace;
  host: string;
  port: number;
  /** One-time browser authentication value; never persisted by the bridge. */
  readonly nonce: string;
  /** Local admin credential used only by the local CLI to retrieve a nonce. */
  readonly adminToken: string;
  localBaseUrl(): string;
  close(): Promise<void>;
}

function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

function isLoopback(req: Request): boolean {
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return EXTENSION_ORIGIN.test(origin);
}

function bearer(req: Request): string {
  const value = req.headers.authorization;
  if (typeof value !== "string") return "";
  const match = /^Bearer ([A-Za-z0-9._-]{32,})$/.exec(value);
  return match?.[1] ?? "";
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function errorCode(error: unknown): { code: string; status: number } {
  if (error instanceof TaskBlockError) return { code: error.code, status: 400 };
  if (error instanceof TaskInboxError) {
    const status = error.code === "WORKSPACE_MISMATCH" ? 403 : error.code === "TASK_NOT_FOUND" ? 404 : 409;
    return { code: error.code, status };
  }
  return { code: "DISPATCH_FAILED", status: 500 };
}

function jsonError(res: Response, status: number, code: string): void {
  res.status(status).json({ ok: false, error: code });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicResult(result: Awaited<ReturnType<TaskDispatcher["dispatch"]>>): ExtensionDispatchResponse {
  const receipt = result.resultReceipt;
  return {
    ok: true,
    authority: "local-task-inbox",
    workspaceId: result.task.workspaceId,
    taskId: result.task.taskId,
    operation: result.task.operation,
    armId: result.task.armId,
    attempt: result.task.attempt,
    dispatchId: receipt.dispatchId,
    resultReceiptId: receipt.receiptId,
    status: receipt.status,
    exitStatus: receipt.exitStatus,
    tests: receipt.tests,
    changedFilesCount: receipt.changedFilesCount,
    ...(receipt.notes ? { notes: receipt.notes } : {}),
  };
}

export async function startExtensionBridge(opts: ExtensionBridgeOptions): Promise<ExtensionBridge> {
  const workspace = new Workspace(opts.workspaceRoot);
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The extension bridge only binds to loopback addresses.");
  }
  if (opts.dispatcher && opts.dispatcher.workspaceId !== workspace.id) {
    throw new TaskInboxError("WORKSPACE_MISMATCH", `dispatcher is bound to ${opts.dispatcher.workspaceId}`);
  }

  const defaultInvoker = new CodexCliInvoker({ workspaceRoot: workspace.root });
  const dispatcher = opts.dispatcher ?? new TaskDispatcher({
    workspaceId: workspace.id,
    invoke: opts.invoke ?? defaultInvoker.invoke.bind(defaultInvoker),
  });
  const nonce = opts.nonce ?? randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9._-]{32,}$/.test(nonce)) throw new Error("EXTENSION_NONCE_INVALID");
  const adminToken = `c2c_extension_admin_${randomBytes(24).toString("base64url")}`;
  let nonceConsumed = false;

  const app = express();
  app.disable("x-powered-by");

  const extensionGuard = (req: Request, res: Response, next: NextFunction): void => {
    if (!isLoopback(req)) {
      res.status(404).end();
      return;
    }
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    if (viaProxy) {
      res.status(404).end();
      return;
    }
    const origin = req.get("origin");
    if (!allowedOrigin(origin)) {
      res.status(403).json({ ok: false, error: "ORIGIN_NOT_ALLOWED" });
      return;
    }
    if (origin) {
      res.set("access-control-allow-origin", origin);
      res.set("access-control-allow-headers", "authorization, content-type");
      res.set("access-control-allow-methods", "POST, OPTIONS");
      res.set("vary", "Origin");
    }
    next();
  };

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    if (!isLoopback(req) || req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || !sameSecret(bearer(req), adminToken)) {
      res.status(404).end();
      return;
    }
    next();
  };

  app.get("/health", (_req, res) => {
    res.json({ service: "c2c-extension-bridge", version: VERSION, workspaceId: workspace.id, status: "ok" });
  });

  app.options("/v1/task/dispatch", extensionGuard, (_req, res) => {
    res.status(204).end();
  });

  app.post("/v1/task/dispatch", extensionGuard, express.json({ limit: MAX_JSON_BYTES }), async (req, res) => {
    const providedNonce = bearer(req);
    if (nonceConsumed) {
      jsonError(res, 409, "NONCE_REPLAYED");
      return;
    }
    if (!sameSecret(providedNonce, nonce)) {
      jsonError(res, 401, "INVALID_NONCE");
      return;
    }
    // Consume before validating task data so an authenticated malformed request
    // cannot be retried as a second handoff.
    nonceConsumed = true;
    if (!isObject(req.body) || Object.keys(req.body).length !== 1 || typeof req.body.block !== "string") {
      jsonError(res, 400, "INVALID_REQUEST");
      return;
    }
    try {
      const block = parseTaskBlock(req.body.block);
      if (block.workspaceId !== workspace.id) throw new TaskInboxError("WORKSPACE_MISMATCH", "task block workspace does not match this bridge");
      const task = dispatcher.inbox.load(block.taskId);
      if (task.armId !== block.armId) throw new TaskInboxError("TASK_REPLAYED", "arm id mismatch");
      if (task.operation !== block.operation) throw new TaskInboxError("OPERATION_NOT_ALLOWED", "operation is not approved");
      const result = await dispatcher.dispatch({
        taskId: block.taskId,
        workspaceId: block.workspaceId,
        attempt: block.attempt,
        idempotencyKey: block.idempotencyKey,
      });
      res.json(publicResult(result));
    } catch (error) {
      const mapped = errorCode(error);
      jsonError(res, mapped.status, mapped.code);
    }
  });

  app.get("/admin/nonce", adminGuard, (_req, res) => {
    if (nonceConsumed) {
      jsonError(res, 409, "NONCE_CONSUMED");
      return;
    }
    res.json({ nonce });
  });

  // Keep parser failures structured and bounded; never reflect parser details
  // or a malformed request body back to the browser.
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (!res.headersSent) jsonError(res, 400, "INVALID_REQUEST");
  });

  const { server, port } = await listen(app, host, opts.port ?? 0);
  const startedAt = new Date().toISOString();
  if (opts.persistRuntime !== false) {
    const runtime: ExtensionRuntimeState = {
      service: "c2c-extension-bridge",
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      port,
      adminToken,
      startedAt,
    };
    writeExtensionRuntime(runtime);
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (opts.persistRuntime !== false) clearExtensionRuntime(workspace.id);
  };
  return { workspace, host, port, nonce, adminToken, localBaseUrl: () => `http://${host}:${port}`, close };
}
