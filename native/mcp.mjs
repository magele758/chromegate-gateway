/** MCP stdio。工具列表只来自扩展按 token scope 过滤后的结果。 */

import crypto from "node:crypto";
import { connectGateway } from "./gateway.mjs";

export function bridgeToolToMcp(tool) {
  const notes = [tool.scope ? `scope: ${tool.scope}` : ""].filter(Boolean).join("; ");
  return {
    name: tool.name,
    description: notes ? `${tool.description}（${notes}）` : tool.description,
    inputSchema: tool.parameters || { type: "object", properties: {} },
  };
}

export function bridgeResponseToMcp(res) {
  const content = [];
  if (res?.ok) content.push({ type: "text", text: JSON.stringify(res.result ?? null, null, 2) });
  else {
    const error = res?.error || { code: "TOOL_FAILED", message: "未知错误" };
    const lines = [`${error.code}: ${error.message}`];
    if (error.hint) lines.push(error.hint);
    content.push({ type: "text", text: lines.join("\n") });
  }
  for (const artifact of res?.artifacts || []) {
    if (artifact.encoding === "base64" && /^image\//.test(artifact.mime || "")) {
      content.push({ type: "image", data: artifact.data, mimeType: artifact.mime });
    }
  }
  return { content, isError: !res?.ok };
}

const HIDDEN = new Set(["list_tools"]);

export function createGatewayMcpHandler({ token, socketPath, agentName = "mcp", connect = connectGateway, notify = () => {} } = {}) {
  let client = null;
  let connecting = null;

  function onEvent(event) {
    notify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", logger: "chromegate", data: event } });
  }

  async function ensure() {
    if (client && !client.closed) return client;
    connecting ||= connect({ socketPath, token, agentName, onEvent })
      .then((next) => {
        client = next;
        return next;
      })
      .finally(() => {
        connecting = null;
      });
    return connecting;
  }

  async function handle(req) {
    if (!req || typeof req !== "object") return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    const { id, method, params } = req;
    if (method === "notifications/initialized" || (typeof method === "string" && method.startsWith("notifications/"))) return null;
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "chromegate", version: "0.1.0" },
        },
      };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") {
      try {
        const current = await ensure();
        const tools = (current.tools || []).filter((tool) => !HIDDEN.has(tool.name)).map(bridgeToolToMcp);
        return { jsonrpc: "2.0", id, result: { tools } };
      } catch (err) {
        return { jsonrpc: "2.0", id, error: { code: -32000, message: err?.message || String(err) } };
      }
    }
    if (method === "tools/call") {
      const name = String(params?.name || "");
      const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      let current;
      try {
        current = await ensure();
      } catch (err) {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: err?.message || String(err) }], isError: true } };
      }
      try {
        const res = await current.call({ id: `mcp-${crypto.randomUUID()}`, tool: name, args });
        return { jsonrpc: "2.0", id, result: bridgeResponseToMcp(res) };
      } catch (err) {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: err?.message || String(err) }], isError: true } };
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  return {
    handle,
    close: () => client?.close(),
  };
}
