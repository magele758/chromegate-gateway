import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDialogState, checkStreamIntegrity, dryRunScenario, loadScenario, runScenario } from "../native/verify.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

assert.deepEqual(checkStreamIntegrity({ domSeqs: [1, 2, 3], sseSeqs: [1, 2, 3] }), { ok: true, count: 3 });
assert.equal(checkStreamIntegrity({ domSeqs: [1, 2, 4], sseSeqs: [1, 2, 4] }).ok, false);
assert.equal(checkStreamIntegrity({ domSeqs: [1, 2], sseSeqs: [1, 2, 3] }).reason.includes("不一致"), true);
assert.equal(checkDialogState({ nodes: [{ text: "确认", hidden: false }], open: true, textIncludes: "确认" }).ok, true);
assert.equal(checkDialogState({ nodes: [], open: true }).ok, false);
assert.equal(checkDialogState({ nodes: [{ hidden: true }], open: false }).ok, true);

function world() {
  let url = "";
  let dialog = false;
  return async (req) => {
    if (req.tool === "navigate") {
      url = req.args.url;
      return { ok: true, result: { tabId: 7, url, created: true } };
    }
    if (req.tool === "click") {
      dialog = req.args.selector === "#open-dialog";
      return { ok: true, result: { ok: true } };
    }
    if (req.tool === "query_dom") {
      if (req.args.selector === "[data-testid=user-id]") {
        const id = url.endsWith("/settings") ? "u-1" : "u-1";
        return { ok: true, result: { nodes: [{ attrs: { "data-user-id": id }, text: id, hidden: false }] } };
      }
      if (req.args.selector === "[data-seq]") {
        return {
          ok: true,
          result: { nodes: [1, 2, 3].map((n) => ({ attrs: { "data-seq": String(n) }, text: String(n), hidden: false })) },
        };
      }
      if (req.args.selector === "[role=dialog]") {
        return { ok: true, result: { nodes: dialog ? [{ text: "请确认", hidden: false, attrs: { role: "dialog" } }] : [] } };
      }
      return { ok: true, result: { nodes: [{ text: "body", hidden: false, attrs: {} }] } };
    }
    if (req.tool === "read_network") {
      return {
        ok: true,
        result: {
          requests: [{ url: "http://127.0.0.1:4173/api/draft", status: 200 }],
          sse: [1, 2, 3].map((seq) => ({ url: "http://127.0.0.1:4173/stream", seq })),
        },
      };
    }
    if (req.tool === "read_console") return { ok: true, result: { messages: [{ level: "log", text: "ready" }] } };
    if (req.tool === "screenshot") {
      return { ok: true, result: { bytes: 80 }, artifacts: [{ encoding: "base64", mime: "image/jpeg", data: Buffer.from("jpeg").toString("base64") }] };
    }
    return { ok: false, error: { code: "UNKNOWN_TOOL", message: req.tool } };
  };
}

for (const name of ["identity.json", "stream-integrity.json", "dialog-state.json"]) {
  const scenario = loadScenario(path.join(root, "scenarios", name));
  const dry = dryRunScenario(scenario);
  assert.equal(dry.ok, true);
  const outcome = await runScenario(scenario, { call: world() });
  assert.equal(outcome.ok, true, name);
  assert.equal(outcome.healed, false);
}

const outbox = fs.mkdtempSync(path.join(os.tmpdir(), "cg-out-"));
const broken = {
  name: "identity-mismatch",
  steps: [
    { tool: "navigate", args: { url: "http://127.0.0.1:4173/profile" } },
    { tool: "query_dom", args: { selector: "[data-testid=user-id]" }, save: "profile" },
    { tool: "navigate", args: { url: "http://127.0.0.1:4173/settings" } },
    { tool: "query_dom", args: { selector: "[data-testid=user-id]" }, save: "settings" },
    { assert: "identity", left: "profile", right: "settings", path: "nodes.0.attrs.data-user-id" },
    { tool: "click", args: { selector: "#fix" } },
  ],
};
let pageUrl = "";
const mismatch = await runScenario(broken, {
  call: async (req) => {
    if (req.tool === "navigate") {
      pageUrl = req.args.url;
      return { ok: true, result: { tabId: 7, url: pageUrl, created: true } };
    }
    if (req.tool === "query_dom" && req.args.selector === "[data-testid=user-id]") {
      const id = pageUrl.endsWith("/settings") ? "u-2" : "u-1";
      return { ok: true, result: { nodes: [{ attrs: { "data-user-id": id }, hidden: false, text: id }] } };
    }
    if (req.tool === "query_dom") return { ok: true, result: { nodes: [] } };
    if (req.tool === "read_console") return { ok: true, result: { messages: [{ level: "error", text: "boom" }] } };
    if (req.tool === "read_network") return { ok: true, result: { requests: [], sse: [] } };
    if (req.tool === "screenshot") return { ok: true, result: { bytes: 80 }, artifacts: [{ encoding: "base64", mime: "image/jpeg", data: Buffer.from("jpeg").toString("base64") }] };
    if (req.tool === "click") return { ok: true, result: { healed: true } };
    return { ok: false, error: { message: "unexpected" } };
  },
  outboxDir: outbox,
});
assert.equal(mismatch.ok, false);
assert.equal(mismatch.healed, false);
assert.equal(mismatch.calls.some((entry) => entry.tool === "click"), false);
assert.equal(mismatch.calls.filter((entry) => entry.phase === "step").every((entry) => entry.tool === "navigate" || entry.tool === "query_dom"), true);
const report = fs.readFileSync(mismatch.file, "utf8");
assert.match(report, /自愈：否/);
assert.match(report, /身份标识不一致|identity/);
assert.equal(fs.existsSync(mismatch.file.replace(/\.md$/, ".jpg")), true);

const blocked = await runScenario({ name: "blocked", steps: [{ tool: "exec_command", args: { command: "id" } }] }, {
  call: async () => {
    throw new Error("不应调用网关");
  },
  outboxDir: outbox,
});
assert.equal(blocked.ok, false);
assert.equal(blocked.calls.length, 0);

const dryOut = execFileSync(process.execPath, ["native/cli.mjs", "verify", "scenarios/identity.json", "--dry-run"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(JSON.parse(dryOut).ok, true);

console.log("verify ok");
