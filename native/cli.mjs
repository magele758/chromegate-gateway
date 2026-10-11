#!/usr/bin/env node
/**
 * chromegate verify scenario.json
 * chromegate inbox enqueue|status
 * chromegate mcp-config
 *
 * 只打印 MCP 配置，不写 Cursor / Claude / Codex 的配置文件，也不登记 Native Host。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectGateway } from "./gateway.mjs";
import { chromegateHome, enqueueJob, inboxStatus } from "./inbox.mjs";
import { dryRunScenario, loadScenario, runScenario } from "./verify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function take(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return "";
  const value = argv[index + 1] || "";
  argv.splice(index, 2);
  return value;
}

function readToken(file) {
  if (!file) return String(process.env.CHROMEGATE_TOKEN || "").trim();
  const expanded = file.startsWith("~") ? path.join(osHome(), file.slice(1)) : file;
  return fs.readFileSync(expanded, "utf8").trim();
}

function osHome() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

export function mcpSnippet({ hostPath = path.join(HERE, "host.mjs"), tokenFile = "~/.chromegate/agents/agent.token", nodePath = process.execPath } = {}) {
  return {
    cursor: {
      mcpServers: {
        chromegate: {
          command: nodePath,
          args: [hostPath, "--mcp", "--token-file", tokenFile],
        },
      },
    },
    claude: `claude mcp add --scope user chromegate -- ${nodePath} ${hostPath} --mcp --token-file ${tokenFile}`,
    codex: `[mcp_servers.chromegate]\ncommand = ${JSON.stringify(nodePath)}\nargs = ${JSON.stringify([hostPath, "--mcp", "--token-file", tokenFile])}`,
  };
}

async function verifyCommand(argv) {
  const dryRun = argv.includes("--dry-run");
  const rest = argv.filter((arg) => arg !== "--dry-run");
  const tokenFile = take(rest, "--token-file");
  const outbox = take(rest, "--outbox");
  const vars = {};
  while (rest.includes("--var")) {
    const pair = take(rest, "--var");
    const eq = pair.indexOf("=");
    if (eq < 1) throw new Error("--var 需要 key=value");
    vars[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const file = rest.find((arg) => !arg.startsWith("--"));
  if (!file) throw new Error("用法：chromegate verify scenario.json [--dry-run] [--token-file f] [--outbox dir] [--var key=value]");
  const scenario = loadScenario(path.resolve(file));
  if (dryRun) {
    console.log(JSON.stringify(dryRunScenario(scenario), null, 2));
    return;
  }
  const token = readToken(tokenFile);
  if (!token) throw new Error("verify 需要 --token-file 或 CHROMEGATE_TOKEN。");
  const client = await connectGateway({ token, agentName: "chromegate-verify" });
  try {
    const outcome = await runScenario(scenario, {
      call: (request) => client.call(request),
      vars,
      outboxDir: outbox || path.join(chromegateHome(), "outbox"),
    });
    console.log(JSON.stringify({ ok: outcome.ok, file: outcome.file || null, healed: false }, null, 2));
    if (!outcome.ok) process.exitCode = 1;
  } finally {
    client.close();
  }
}

function inboxCommand(argv) {
  const root = chromegateHome();
  const sub = argv[0];
  if (sub === "status") {
    console.log(JSON.stringify(inboxStatus(root), null, 2));
    return;
  }
  if (sub !== "enqueue") throw new Error("用法：chromegate inbox enqueue --tool name --token-file f [--arg key=value]");
  const args = argv.slice(1);
  const tokenFile = take(args, "--token-file");
  const tool = take(args, "--tool");
  const toolArgs = {};
  while (args.includes("--arg")) {
    const pair = take(args, "--arg");
    const eq = pair.indexOf("=");
    if (eq < 1) throw new Error("--arg 需要 key=value");
    toolArgs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const token = readToken(tokenFile);
  if (!tool || !token) throw new Error("enqueue 需要 --tool 和 --token-file。");
  console.log(JSON.stringify(enqueueJob({ root, tool, args: toolArgs, token, agentName: "cli" }), null, 2));
}

function printMcp() {
  const snippet = mcpSnippet();
  console.log(JSON.stringify(snippet, null, 2));
  console.error("以上是配置片段。请你自己粘贴到 Cursor / Claude Code / Codex。此命令不会写配置文件，也不会登记 Native Host。");
}

const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === "verify") return verifyCommand(rest);
  if (command === "inbox") return inboxCommand(rest);
  if (command === "mcp-config") return printMcp();
  throw new Error("用法：chromegate verify|inbox|mcp-config");
}

if (isMain) {
  main().catch((err) => {
    console.error(err?.message || String(err));
    process.exit(2);
  });
}
