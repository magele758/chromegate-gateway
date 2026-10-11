#!/usr/bin/env node
/**
 * ChromeGate Gateway native host。只做两件事：Native Messaging 网关 broker，以及 ~/.chromegate-gw inbox/outbox。
 * --mcp 时作为 MCP stdio 客户端连到同一个网关。不提供本机命令或任意文件访问。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOCKET_PROTOCOL, createBroker, defaultSocketPath } from "./gateway.mjs";
import { encodeMessage, tryReadMessage } from "./framing.mjs";
import { chromegateHome, processInboxOnce } from "./inbox.mjs";
import { createGatewayMcpHandler } from "./mcp.mjs";

export const HOST_NAME = "com.chromegate.gateway";
export const HOST_VERSION = "0.1.0";

const REFUSED = new Set(["exec", "fs", "shell", "clipboard_write"]);

export function resolveMcpToken({ argv = process.argv, env = process.env, home = os.homedir() } = {}) {
  const index = argv.indexOf("--token-file");
  if (index >= 0) {
    const raw = String(argv[index + 1] || "").trim();
    if (!raw) throw new Error("--token-file 需要路径。");
    const file = raw.startsWith("~") ? path.join(home, raw.slice(1)) : raw;
    return { token: fs.readFileSync(file, "utf8").trim(), source: file };
  }
  const token = String(env.CHROMEGATE_GW_TOKEN || "").trim();
  return token ? { token, source: "CHROMEGATE_GW_TOKEN" } : { token: "", source: "" };
}

export function createHostMessageHandler({
  write,
  socketPath = defaultSocketPath(),
  makeBroker = createBroker,
  homeRoot = chromegateHome(),
  log = () => {},
  inboxIntervalMs = 2000,
} = {}) {
  let broker = null;
  let starting = null;
  let inboxTimer = null;

  function setInbox(enabled) {
    if (inboxTimer) clearInterval(inboxTimer);
    inboxTimer = null;
    if (!enabled || !broker) return;
    const tick = () => {
      processInboxOnce({
        root: homeRoot,
        call: (job) => broker.localCall({ token: job.token, agentName: job.agentName || "inbox", request: job.request }),
      }).catch((err) => log(err?.message || String(err)));
    };
    inboxTimer = setInterval(tick, inboxIntervalMs);
    inboxTimer.unref?.();
    tick();
  }

  async function startBroker() {
    if (broker) return broker;
    starting ||= (async () => {
      const next = makeBroker({ socketPath, post: write, log });
      await next.start();
      broker = next;
      return next;
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  return {
    async onMessage(msg) {
      const op = String(msg?.op || "");
      if (REFUSED.has(op)) {
        write({ ok: false, error: "ChromeGate Gateway host 不提供本机命令或任意文件访问。" });
        return;
      }
      if (msg?.type === "broker.start") {
        try {
          const next = await startBroker();
          setInbox(msg.inbox === true);
          write({ type: "broker.ready", socketPath: next.socketPath, version: HOST_VERSION, protocol: SOCKET_PROTOCOL });
        } catch (err) {
          write({ type: "broker.error", error: err?.message || String(err) });
        }
        return;
      }
      if (msg?.type === "inbox.set") {
        setInbox(msg.enabled === true);
        return;
      }
      if (typeof msg?.type === "string" && msg.type.startsWith("bridge.")) {
        broker?.handleExtensionMessage(msg);
        return;
      }
      if (op === "ping" || msg?.type === "ping") {
        write({ ok: true, version: HOST_VERSION, name: HOST_NAME });
        return;
      }
      write({ ok: false, error: "未知请求。host 只承载网关。" });
    },
    async close() {
      if (inboxTimer) clearInterval(inboxTimer);
      inboxTimer = null;
      await starting?.catch(() => {});
      await broker?.close();
      broker = null;
    },
    isBroker: () => Boolean(broker),
  };
}

export function attachStdio(stdin = process.stdin, stdout = process.stdout, { log = (message) => process.stderr.write(`[chromegate-gw-host] ${message}\n`) } = {}) {
  const write = (obj) => stdout.write(encodeMessage(obj));
  const host = createHostMessageHandler({ write, log });
  let buf = Buffer.alloc(0);
  const finish = (code) => {
    host.close().catch(() => {}).finally(() => process.exit(code));
  };
  stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      let parsed;
      try {
        parsed = tryReadMessage(buf);
      } catch (err) {
        write({ ok: false, error: err.message || String(err) });
        finish(1);
        return;
      }
      if (!parsed) break;
      buf = parsed.rest;
      host.onMessage(parsed.msg);
    }
  });
  stdin.on("end", () => finish(0));
  stdin.on("error", () => finish(1));
  return host;
}

function attachMcp(handler) {
  let lineBuf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    lineBuf += chunk;
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const reply = await handler(JSON.parse(trimmed));
        if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
      } catch (err) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: err.message || String(err) } })}\n`);
      }
    }
  });
}

const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const mcp = process.argv.includes("--mcp") || process.env.CHROMEGATE_GW_MCP === "1";
  process.stdin.resume();
  if (mcp) {
    let resolved;
    try {
      resolved = resolveMcpToken();
    } catch (err) {
      process.stderr.write(`[chromegate-gw] 读取 token 失败：${err.message || err}\n`);
      process.exit(1);
    }
    if (!resolved.token) {
      process.stderr.write("[chromegate-gw] 缺少 token。传入 --token-file 或 CHROMEGATE_GW_TOKEN。\n");
      process.exit(1);
    }
    const nameIndex = process.argv.indexOf("--agent-name");
    const agentName = nameIndex >= 0 ? String(process.argv[nameIndex + 1] || "") : "mcp";
    const gateway = createGatewayMcpHandler({
      token: resolved.token,
      agentName,
      notify: (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`),
    });
    attachMcp((req) => gateway.handle(req));
  } else {
    attachStdio();
  }
}
