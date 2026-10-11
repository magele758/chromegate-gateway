import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectGateway, createBroker, defaultSocketPath } from "../native/gateway.mjs";
import { encodeMessage, tryReadMessage } from "../native/framing.mjs";
import { createHostMessageHandler } from "../native/host.mjs";
import { createGatewayMcpHandler } from "../native/mcp.mjs";
import { mcpSnippet } from "../native/cli.mjs";

const socketPath = defaultSocketPath({ env: {}, home: "/Users/example", platform: "darwin" });
assert.equal(socketPath, "/Users/example/.chromegate-gw/bridge.sock");

const framed = encodeMessage({ op: "ping" });
const parsed = tryReadMessage(framed);
assert.equal(parsed.msg.op, "ping");
assert.equal(parsed.rest.length, 0);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-gw-"));
const sock = path.join(dir, "bridge.sock");
let broker;
broker = createBroker({
  socketPath: sock,
  post(msg) {
    const tool = msg.request?.tool;
    broker.handleExtensionMessage({
      type: "bridge.result",
      callId: msg.callId,
      response: tool === "list_tools"
        ? { ok: true, result: { tools: [{ name: "list_tabs", description: "tabs", scope: "tabs:read" }], agent: { name: "cursor", scopes: ["tabs:read"] } } }
        : { ok: true, result: { echoed: tool } },
    });
  },
});
await broker.start();
try {
  const client = await connectGateway({ socketPath: sock, token: "cgk_example", timeoutMs: 2000 });
  assert.equal(client.tools[0].name, "list_tabs");
  const echoed = await client.call({ id: "1", tool: "list_tabs", args: {} });
  assert.equal(echoed.result.echoed, "list_tabs");
  client.close();
  const local = await broker.localCall({ token: "cgk_example", request: { id: "inbox-1", tool: "query_dom", args: { selector: "body" } } });
  assert.equal(local.result.echoed, "query_dom");
} finally {
  await broker.close();
}

await assert.rejects(() => connectGateway({ socketPath: path.join(dir, "missing.sock"), token: "x", timeoutMs: 400 }));

const messages = [];
const handler = createHostMessageHandler({
  write: (msg) => messages.push(msg),
  socketPath: path.join(dir, "unused.sock"),
  homeRoot: dir,
});
await handler.onMessage({ op: "exec", command: "id" });
await handler.onMessage({ op: "fs", action: "readText", path: "/etc/passwd" });
await handler.onMessage({ op: "ping" });
assert.equal(messages[0].ok, false);
assert.equal(messages[1].ok, false);
assert.match(messages[0].error, /不提供本机命令/);
assert.equal(messages[2].ok, true);
await handler.close();

const mcp = createGatewayMcpHandler({
  token: "cgk_example",
  connect: async () => ({
    tools: [
      { name: "list_tools", description: "meta" },
      { name: "list_tabs", description: "tabs", scope: "tabs:read", parameters: { type: "object", properties: {} } },
      { name: "click", description: "click", scope: "page:act", parameters: { type: "object", properties: {} } },
    ],
    closed: false,
    close() {},
    call: async (req) => ({ ok: req.tool !== "exec_command", result: { tool: req.tool }, error: { code: "UNKNOWN_TOOL", message: "未知工具" } }),
  }),
});
const listed = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["list_tabs", "click"]);
const forwarded = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "exec_command", arguments: { command: "id" } } });
assert.equal(forwarded.result.isError, true);

const snippet = mcpSnippet({ hostPath: "/opt/chromegate-gateway/native/host.mjs", tokenFile: "/tmp/cursor.token", nodePath: "/usr/bin/node" });
assert.deepEqual(snippet.cursor.mcpServers["chromegate-gateway"].args, ["/opt/chromegate-gateway/native/host.mjs", "--mcp", "--token-file", "/tmp/cursor.token"]);
assert.match(snippet.claude, /--mcp/);
assert.match(snippet.codex, /mcp_servers\.chromegate-gateway/);

console.log("gateway ok");
