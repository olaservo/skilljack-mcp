import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
  getUiCapability,
  normalizeUiToolMeta,
  registerAppResource,
  registerAppTool,
} from "./ui-meta.js";

/**
 * These lock in the behaviour vendored from @modelcontextprotocol/ext-apps@1.7.5.
 * Hosts locate a tool's UI by reading `_meta['ui/resourceUri']` and/or
 * `_meta.ui.resourceUri`; if either stops being emitted the app silently stops
 * rendering, which no other test in this repo would catch.
 */
describe("ui-meta constants", () => {
  it("matches ext-apps@1.7.5 verbatim", () => {
    expect(RESOURCE_URI_META_KEY).toBe("ui/resourceUri");
    expect(RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(EXTENSION_ID).toBe("io.modelcontextprotocol/ui");
  });
});

describe("normalizeUiToolMeta", () => {
  it("adds the legacy flat key when only the nested one is set", () => {
    expect(normalizeUiToolMeta({ ui: { resourceUri: "ui://x/a.html" } })).toEqual({
      ui: { resourceUri: "ui://x/a.html" },
      "ui/resourceUri": "ui://x/a.html",
    });
  });

  it("adds the nested key when only the legacy one is set", () => {
    expect(normalizeUiToolMeta({ "ui/resourceUri": "ui://x/a.html" })).toEqual({
      ui: { resourceUri: "ui://x/a.html" },
      "ui/resourceUri": "ui://x/a.html",
    });
  });

  it("preserves other nested ui fields when mirroring to the flat key", () => {
    expect(
      normalizeUiToolMeta({ ui: { resourceUri: "ui://x/a.html", visibility: ["app"] } })
    ).toEqual({
      ui: { resourceUri: "ui://x/a.html", visibility: ["app"] },
      "ui/resourceUri": "ui://x/a.html",
    });
  });

  it("passes through untouched when both keys are already present", () => {
    const meta = { ui: { resourceUri: "ui://a" }, "ui/resourceUri": "ui://b" };
    expect(normalizeUiToolMeta(meta)).toBe(meta);
  });

  it("passes through untouched when neither key is present", () => {
    const meta = { other: 1 };
    expect(normalizeUiToolMeta(meta)).toBe(meta);
  });

  it("keeps unrelated _meta keys", () => {
    expect(normalizeUiToolMeta({ ui: { resourceUri: "ui://x" }, custom: "keep" })).toEqual({
      ui: { resourceUri: "ui://x" },
      "ui/resourceUri": "ui://x",
      custom: "keep",
    });
  });
});

describe("registerAppTool / registerAppResource", () => {
  it("registers a tool whose advertised _meta carries both UI keys", () => {
    const server = new McpServer({ name: "t", version: "0" });
    const tool = registerAppTool(
      server,
      "demo",
      {
        title: "Demo",
        description: "demo",
        inputSchema: z.object({}),
        _meta: { ui: { resourceUri: "ui://demo/view.html", visibility: ["app"] } },
      },
      async () => ({ content: [{ type: "text", text: "ok" }] })
    );

    expect(tool._meta).toEqual({
      ui: { resourceUri: "ui://demo/view.html", visibility: ["app"] },
      "ui/resourceUri": "ui://demo/view.html",
    });
  });

  it("defaults the resource mime type to the MCP Apps profile", () => {
    const server = new McpServer({ name: "t", version: "0" });
    const resource = registerAppResource(server, "ui://demo/view.html", "ui://demo/view.html", {}, async () => ({
      contents: [{ uri: "ui://demo/view.html", mimeType: RESOURCE_MIME_TYPE, text: "<html></html>" }],
    }));

    expect(resource.metadata?.mimeType).toBe(RESOURCE_MIME_TYPE);
  });

  it("lets a caller-supplied mime type win over the default", () => {
    const server = new McpServer({ name: "t", version: "0" });
    const resource = registerAppResource(
      server,
      "ui://demo/other.html",
      "ui://demo/other.html",
      { mimeType: "text/html" },
      async () => ({ contents: [] })
    );

    expect(resource.metadata?.mimeType).toBe("text/html");
  });
});

describe("getUiCapability", () => {
  it("returns undefined without client capabilities", () => {
    expect(getUiCapability(undefined)).toBeUndefined();
  });

  it("returns undefined when the client advertises no UI extension", () => {
    expect(getUiCapability({ extensions: {} })).toBeUndefined();
    expect(getUiCapability({})).toBeUndefined();
  });

  it("returns the advertised UI extension capability", () => {
    const cap = { mimeTypes: [RESOURCE_MIME_TYPE] };
    expect(getUiCapability({ extensions: { [EXTENSION_ID]: cap } })).toEqual(cap);
  });
});
