import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const extensionRoot = path.resolve(process.cwd(), "extension");

describe("Chromium extension safety surface", () => {
  it("has only the narrow storage/loopback permissions and ChatGPT matches", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8")) as {
      permissions?: string[];
      host_permissions?: string[];
      content_scripts?: Array<{ matches?: string[] }>;
    };
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*", "http://localhost/*"]);
    expect(manifest.content_scripts?.[0]?.matches).toEqual(["https://chatgpt.com/*", "https://chat.openai.com/*"]);
  });

  it("does not contain browser credential capture or generic execution APIs", () => {
    const sources = ["content.js", "service-worker.js", "popup.js"].map((file) =>
      fs.readFileSync(path.join(extensionRoot, file), "utf8")
    );
    const source = sources.join("\n");
    expect(source).not.toMatch(/chrome\.(cookies|webRequest|debugger|scripting|tabs)\b/);
    expect(source).not.toMatch(/document\.cookie\b/);
    expect(source).not.toMatch(/eval\s*\(|new\s+Function\s*\(/);
    expect(source).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
  });
});
