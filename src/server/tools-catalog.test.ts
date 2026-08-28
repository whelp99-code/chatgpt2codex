import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import type { ToolContext } from "../types.js";

const CONTROL_TOOL_NAMES = ["computer_screenshot", "computer_request_action", "computer_action_status", "computer_kill_switch"];

function makeCtx(): ToolContext {
  const stateDir = "/tmp/chatgpt2codex-tools-catalog-test";
  return {
    workspaceRoot: "/tmp",
    stateDir,
    registry: [],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async () => null,
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: "/tmp",
      stateDir,
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

describe("tool catalog", () => {
  it("keeps the one-shot E2E tool out of destructive/open-world routing", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { annotations?: Record<string, unknown>; inputSchema?: { shape?: Record<string, unknown> } }>;
      }
    )._registeredTools;
    const oneShot = tools?.e2e_test_and_show_screenshot;

    expect(oneShot?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(oneShot?.inputSchema?.shape?.serverCommand).toBeUndefined();
    expect(oneShot?.inputSchema?.shape?.testCommand).toBeUndefined();
    expect(oneShot?.inputSchema?.shape?.waitUrl).toBeUndefined();
  });

  it("declares the ChatGPT widget template for E2E screenshot tools", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { _meta?: Record<string, unknown> }>;
      }
    )._registeredTools;

    for (const name of ["e2e_test_and_show_screenshot", "e2e_screenshot", "e2e_open_url_screenshot", "e2e_run_command"]) {
      expect(tools?.[name]?._meta?.["openai/outputTemplate"], name).toBe("ui://widget/e2e-screenshots.html");
    }

    const resources = (
      server as unknown as {
        _registeredResources?: Record<
          string,
          {
            metadata?: { mimeType?: string; _meta?: Record<string, unknown> };
            readCallback?: (uri: URL) => Promise<{ contents: Array<{ mimeType?: string; text?: string }> }>;
          }
        >;
      }
    )._registeredResources;
    const widget = resources?.["ui://widget/e2e-screenshots.html"];
    expect(widget?.metadata?.mimeType).toBe("text/html+skybridge");
    expect(widget?.metadata?._meta?.["openai/widgetCSP"]).toBeDefined();

    const read = await widget?.readCallback?.(new URL("ui://widget/e2e-screenshots.html"));
    const content = read?.contents?.[0];
    expect(content?.mimeType).toBe("text/html+skybridge");
    expect(content?.text).toContain("chatgpt2codex/screenshots");
    expect(content?.text).toContain("openai:set_globals");
    expect(content?.text).toContain("dataUri");
  });

  it("exposes GPT Image 2 import routing and ChatGPT URL intake", async () => {
    const server = await createServer(makeCtx());
    const tools = (server as unknown as { _registeredTools?: Record<string, { description?: string; handler?: (input: unknown) => Promise<unknown> }> })
      ._registeredTools;

    expect(tools?.gpt_image_2_generate).toBeUndefined();
    expect(tools?.open_chatgpt_images_app?.description).toContain("ChatGPT Images app");
    expect(tools?.save_chatgpt_image?.description).toContain("Single app-friendly");
    expect(tools?.save_chatgpt_image_from_url?.description).toContain("ChatGPT-generated image");
    expect(tools?.save_chatgpt_image_from_url?.description).toContain("chatgpt.com/s/m_...");
    expect(tools?.save_chatgpt_screen_images).toBeUndefined();
    expect(tools?.generate_chatgpt_image).toBeUndefined();
    expect(tools?.chatgpt_image_loop).toBeUndefined();
    expect(tools?.list_pending_images).toBeUndefined();
    expect(tools?.save_image_from_pending).toBeUndefined();

    const guide = tools?.gpt_image_2_workflow;
    expect(guide?.description).toContain("import workflow");

    const result = (await guide?.handler?.({})) as {
      structuredContent?: {
        chatgpt2codexToolCall?: { namespace?: string; tool?: string; ok?: boolean };
        toolAvailabilityGate?: { namespace?: string };
        doThis?: string[];
        ifNativeImageGenerationUnavailable?: string[];
        notThis?: string[];
        saveTools?: string[];
      };
      content?: Array<{ text: string }>;
    };
    expect(result.structuredContent?.chatgpt2codexToolCall).toMatchObject({
      namespace: "ChatGPT_To_Codex",
      tool: "gpt_image_2_workflow",
      ok: true,
    });
    expect(result.structuredContent?.toolAvailabilityGate?.namespace).toBe("ChatGPT_To_Codex");
    expect(result.structuredContent?.doThis?.join(" ")).toContain("reselect ChatGPT To Codex");
    expect(result.structuredContent?.doThis?.join(" ")).toContain("Generate with ChatGPT's native image surface");
    expect(result.structuredContent?.doThis?.join(" ")).toContain("chatgpt.com/s/m_...");
    expect(result.structuredContent?.ifNativeImageGenerationUnavailable?.join(" ")).toContain("Share/Copy Link");
    expect(result.structuredContent?.notThis?.join(" ")).toContain("Do not call Codex");
    expect(result.structuredContent?.notThis?.join(" ")).toContain("python_user_visible");
    expect(result.structuredContent?.notThis?.join(" ")).toContain("automatic capture helpers");
    expect(result.structuredContent?.saveTools).toContain("open_chatgpt_images_app");
    expect(result.structuredContent?.saveTools).toContain("save_chatgpt_image");
    expect(result.structuredContent?.saveTools).toContain("save_chatgpt_image_from_url");
    expect(result.structuredContent?.saveTools).toContain("save_image_from_url");
    expect(result.content?.[0]?.text).toContain("native ChatGPT GPT Image 2 generation first");
  });

  it("keeps broad context-pack off the ChatGPT-visible tool list", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { description?: string }>;
      }
    )._registeredTools;

    expect(tools?.code_context_pack).toBeDefined();
    expect(tools?.code_context_pack?.description).toContain("ChatGPT should prefer code_search");

    const handler = (
      server.server as unknown as {
        _requestHandlers?: Map<
          string,
          (request: { method: string; params: Record<string, never> }) => Promise<{ tools: Array<{ name: string }> }>
        >;
      }
    )._requestHandlers?.get("tools/list");
    const listed = await handler?.({ method: "tools/list", params: {} });
    expect(listed?.tools.map((tool) => tool.name)).not.toContain("code_context_pack");
  });

  it("agent_guide exposes Codex-grade loop, tool surface, and safety model", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }>;
      }
    )._registeredTools;

    const result = (await tools?.agent_guide?.handler?.({})) as {
      structuredContent?: {
        codexGradeLoop?: string[];
        toolSurfaceMap?: Record<string, string[]>;
        securityModel?: string[];
        desktopControlModel?: string[];
      };
    };

    expect(result.structuredContent?.codexGradeLoop?.join(" ")).toContain("Discover");
    expect(result.structuredContent?.codexGradeLoop?.join(" ")).toContain("Verify");
    expect(result.structuredContent?.toolSurfaceMap?.modify).toEqual(
      expect.arrayContaining(["file_apply_patch", "file_create", "local_shell_run"]),
    );
    expect(result.structuredContent?.toolSurfaceMap?.verify).toEqual(
      expect.arrayContaining(["e2e_test_and_show_screenshot", "e2e_run_command"]),
    );
    expect(result.structuredContent?.securityModel?.join(" ")).toContain("current-turn ChatGPT_To_Codex tool proof");
    expect(result.structuredContent?.securityModel?.join(" ")).toContain("Prompt-injection posture");
    expect(result.structuredContent?.desktopControlModel?.join(" ")).toContain("kill switch");
    expect(result.structuredContent?.desktopControlModel?.join(" ")).toContain("sensitive apps");
  });

  it("exposes bounded GitHub delivery tools without merge or admin operations", async () => {
    const server = await createServer(makeCtx());
    const tools = (
      server as unknown as {
        _registeredTools?: Record<
          string,
          {
            annotations?: Record<string, unknown>;
            handler?: (input: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>;
          }
        >;
      }
    )._registeredTools;
    expect(tools).toBeDefined();

    const readTools = ["github_issue_list", "github_issue_get", "github_checks_get"];
    const writeTools = [
      "github_issue_create",
      "github_issue_update",
      "github_issue_comment",
      "github_issue_set_state",
      "github_pr_create",
      "github_pr_update",
      "github_pr_comment",
      "github_pr_request_review",
      "github_delivery",
    ];
    for (const name of readTools) {
      expect(tools?.[name]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    for (const name of writeTools) {
      expect(tools?.[name]?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      });
    }
    expect(tools?.github_pr_merge).toBeUndefined();
    expect(tools?.github_workflow_run).toBeUndefined();
    expect(tools?.github_release_create).toBeUndefined();

    const denied = await tools?.github_issue_create?.handler?.({
      projectId: "project",
      title: "No lease",
      body: "Must fail before spawning gh",
    });
    expect(denied?.structuredContent).toMatchObject({ code: "LEASE_REQUIRED" });
  });

  describe("ChatGPT confirm-model exposure (CHATGPT2CODEX_CONTROL_CHATGPT)", () => {
    afterEach(() => {
      delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
    });

    async function toolsListNames(): Promise<string[]> {
      const server = await createServer(makeCtx());
      const handler = (
        server.server as unknown as {
          _requestHandlers?: Map<
            string,
            (request: { method: string; params: Record<string, never> }) => Promise<{
              tools: Array<{ name: string; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }>;
            }>
          >;
        }
      )._requestHandlers?.get("tools/list");
      const listed = await handler?.({ method: "tools/list", params: {} });
      return listed?.tools.map((t) => t.name) ?? [];
    }

    it("hides the 4 control tools from tools/list by default (flag unset)", async () => {
      const names = await toolsListNames();
      for (const name of CONTROL_TOOL_NAMES) {
        expect(names, name).not.toContain(name);
      }
    });

    it.each(["0", "false", "off"])("hides the 4 control tools from tools/list when explicitly opted out (%s)", async (value) => {
      process.env.CHATGPT2CODEX_CONTROL_CHATGPT = value;
      const names = await toolsListNames();
      for (const name of CONTROL_TOOL_NAMES) {
        expect(names, name).not.toContain(name);
      }
    });

    it("exposes all 4 control tools in tools/list once CHATGPT2CODEX_CONTROL_CHATGPT=1, with oauth2 securitySchemes and Confirm/Deny-driving annotations", async () => {
      process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
      const server = await createServer(makeCtx());
      const handler = (
        server.server as unknown as {
          _requestHandlers?: Map<
            string,
            (request: { method: string; params: Record<string, never> }) => Promise<{
              tools: Array<{
                name: string;
                annotations?: Record<string, unknown>;
                securitySchemes?: Array<{ type?: string; scopes?: string[] }>;
                _meta?: Record<string, unknown>;
              }>;
            }>
          >;
        }
      )._requestHandlers?.get("tools/list");
      const listed = await handler?.({ method: "tools/list", params: {} });
      const byName = new Map((listed?.tools ?? []).map((t) => [t.name, t]));

      for (const name of CONTROL_TOOL_NAMES) {
        const tool = byName.get(name);
        expect(tool, name).toBeDefined();
        expect(tool?.securitySchemes, name).toMatchObject([{ type: "oauth2", scopes: ["chatgpt2codex"] }]);
        expect(tool?._meta?.["openai/visibility"], name).toBe("public");
      }

      // request_action / kill_switch / screenshot must drive ChatGPT's
      // client-side Confirm/Deny prompt (non-read-only, destructive);
      // action_status is a pure read and must not prompt.
      expect(byName.get("computer_request_action")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.get("computer_kill_switch")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.get("computer_screenshot")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.get("computer_action_status")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    });
  });
});
