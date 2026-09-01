import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { TextEncoder } from "node:util";
import { describe, expect, it } from "vitest";
import { computeApprovalSummaryHash } from "../src/inbox/approval.js";
import { formatTaskBlock } from "../src/extension/task-block.js";

type FixtureEvent = { isTrusted: boolean };
type FixtureListener = (event: FixtureEvent) => void;

class FixtureElement {
  readonly tagName: string;
  readonly dataset: Record<string, string> = {};
  readonly children: FixtureElement[] = [];
  parentElement: FixtureElement | null = null;
  textContent: string;
  type = "";
  disabled = false;
  private readonly listeners = new Map<string, FixtureListener[]>();

  constructor(tagName: string, textContent = "") {
    this.tagName = tagName.toUpperCase();
    this.textContent = textContent;
  }

  appendChild(child: FixtureElement): FixtureElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  closest(selector: string): FixtureElement | null {
    if (selector !== "pre") return null;
    let current: FixtureElement | null = this;
    while (current) {
      if (current.tagName === "PRE") return current;
      current = current.parentElement;
    }
    return null;
  }

  insertAdjacentElement(position: string, element: FixtureElement): FixtureElement | null {
    if (position !== "afterend" || !this.parentElement) return null;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    if (index < 0) return null;
    element.parentElement = this.parentElement;
    siblings.splice(index + 1, 0, element);
    return element;
  }

  addEventListener(type: string, listener: FixtureListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(type: string, event: FixtureEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FixtureDocument {
  readonly documentElement = new FixtureElement("html");
  readonly body = this.documentElement.appendChild(new FixtureElement("body"));

  createElement(tagName: string): FixtureElement {
    return new FixtureElement(tagName);
  }

  querySelectorAll(selector: string): FixtureElement[] {
    if (selector !== "code") throw new Error(`unexpected selector: ${selector}`);
    return descendants(this.documentElement).filter((element) => element.tagName === "CODE");
  }
}

class FixtureMutationObserver {
  observe(): void {}
}

function descendants(root: FixtureElement): FixtureElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function findByTag(root: FixtureElement, tagName: string): FixtureElement[] {
  return [root, ...descendants(root)].filter((element) => element.tagName === tagName.toUpperCase());
}

const contentScript = fs.readFileSync(path.resolve(process.cwd(), "extension/content.js"), "utf8");

function runContentScript(document: FixtureDocument): { messages: unknown[] } {
  const messages: unknown[] = [];
  vm.runInNewContext(contentScript, {
    chrome: {
      runtime: {
        sendMessage(message: unknown, callback?: (response: unknown) => void) {
          messages.push(message);
          callback?.({ ok: true, result: { status: "SUCCEEDED" } });
        },
      },
    },
    document,
    MutationObserver: FixtureMutationObserver,
    navigator: { userActivation: { isActive: true } },
    TextEncoder,
  });
  return { messages };
}

function validTaskBlock(): string {
  const taskSummary = "Render the local browser handoff";
  const instruction = "Forward the approved task to local Codex.";
  return formatTaskBlock({
    taskId: "c2c_dom",
    workspaceId: "workspace_dom",
    operation: "codex_turn",
    attempt: 1,
    armId: "arm_dom",
    idempotencyKey: "idem_dom",
    taskSummary,
    instruction,
    approvalSummaryHash: computeApprovalSummaryHash(taskSummary, instruction),
  });
}

describe("ChatGPT content-script DOM fixtures", () => {
  it("renders controls for pre code and standalone code, but only after strict parsing and a click", () => {
    const block = validTaskBlock();
    const document = new FixtureDocument();

    const pre = new FixtureElement("pre");
    const preCode = pre.appendChild(new FixtureElement("code", block));
    document.body.appendChild(pre);

    const standaloneContainer = new FixtureElement("div");
    const standaloneCode = standaloneContainer.appendChild(new FixtureElement("code", `\`\`\`c2c-task\n${block}\n\`\`\``));
    document.body.appendChild(standaloneContainer);

    const renderedLanguageContainer = new FixtureElement("div");
    const renderedLanguageCode = renderedLanguageContainer.appendChild(new FixtureElement("code", `c2c-task\n${block}`));
    document.body.appendChild(renderedLanguageContainer);

    const ordinaryInline = document.body.appendChild(new FixtureElement("code", "inline c2c-task text"));
    const wrongLanguage = document.body.appendChild(new FixtureElement("code", `python\n${block}`));
    const missingMarker = document.body.appendChild(new FixtureElement("code", `c2c-task\n${block.replace("[C2C_TASK]\n", "")}`));
    const duplicateField = document.body.appendChild(new FixtureElement("code", `c2c-task\n${block.replace("ARM_ID: arm_dom", "ARM_ID: arm_dom\nARM_ID: arm_dup")}`));
    const incompleteFence = document.body.appendChild(new FixtureElement("code", `\`\`\`c2c-task\n${block}\n`));
    const { messages } = runContentScript(document);
    const buttons = findByTag(document.documentElement, "button");

    expect(buttons).toHaveLength(3);
    expect(preCode.dataset.c2cHandoffAttached).toBe("1");
    expect(standaloneCode.dataset.c2cHandoffAttached).toBe("1");
    expect(renderedLanguageCode.dataset.c2cHandoffAttached).toBe("1");
    expect(ordinaryInline.dataset.c2cHandoffAttached).toBeUndefined();
    expect(wrongLanguage.dataset.c2cHandoffAttached).toBeUndefined();
    expect(missingMarker.dataset.c2cHandoffAttached).toBeUndefined();
    expect(duplicateField.dataset.c2cHandoffAttached).toBeUndefined();
    expect(incompleteFence.dataset.c2cHandoffAttached).toBeUndefined();
    expect(messages).toEqual([]);

    buttons[2].dispatchEvent("click", { isTrusted: true });
    expect(messages).toEqual([{ type: "dispatchTask", block: renderedLanguageCode.textContent, userActivated: true }]);
    expect(buttons[2].textContent).toBe("Sent");
  });
});
