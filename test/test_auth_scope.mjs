import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_SCOPES,
  DEFAULT_TOKEN_SCOPES,
  SCOPE_PRESETS,
  createTokenRecord,
  looksLikeToken,
  normalizeScopes,
  scopesForNewToken,
  verifyToken,
} from "../extension/lib/bridge/auth.js";
import { summarizeArgs } from "../extension/lib/bridge/audit.js";
import { runJsRestricted } from "../extension/lib/run-js.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

assert.deepEqual(scopesForNewToken(undefined), ["tabs:read", "page:read"]);
assert.equal(DEFAULT_TOKEN_SCOPES.includes("page:act"), false);
assert.equal(DEFAULT_TOKEN_SCOPES.includes("page:js"), false);
assert.deepEqual(scopesForNewToken(["page:read", "page:act"]), ["page:read", "page:act"]);
assert.deepEqual(normalizeScopes(["tabs:read", "page:act", "clipboard", "cookies"]), ["tabs:read", "page:act"]);
assert.equal(AGENT_SCOPES.includes("page:js"), true);
assert.equal(SCOPE_PRESETS["read-only"].includes("page:act"), false);
assert.equal(SCOPE_PRESETS.operate.includes("page:act"), true);
assert.equal(SCOPE_PRESETS.full.includes("page:js"), true);

const minted = await createTokenRecord({ name: "cursor", scopes: scopesForNewToken(undefined), origins: ["http://127.0.0.1:*"] });
assert.equal(looksLikeToken(minted.token), true);
assert.equal(minted.token.startsWith("cgk_"), true);
assert.notEqual(minted.record.hash, minted.token);
assert.deepEqual(minted.record.scopes, ["tabs:read", "page:read"]);
await verifyToken([minted.record], minted.token, minted.record.createdAt);

const expired = await createTokenRecord(
  { name: "old", scopes: ["tabs:read"], origins: ["http://127.0.0.1:*"], expiresAt: 1000 },
  { now: 500 },
);
await assert.rejects(() => verifyToken([expired.record], expired.token, 1000), (err) => err.code === "UNAUTHORIZED");
expired.record.revokedAt = 600;
await assert.rejects(() => verifyToken([expired.record], expired.token, 550), (err) => /吊销/.test(err.message));
assert.equal(looksLikeToken("plk_" + "a".repeat(43)), false);

const summary = summarizeArgs({ selector: "#ok", code: "document.title", text: "hello", token: "cgk_secret" });
assert.equal(summary.selector, "#ok");
assert.equal(summary.code, "[14 chars]");
assert.equal(summary.token, "[redacted]");

const calls = [];
const viaDebugger = await runJsRestricted(3, "1+1", {
  debuggerSend: async (tabId, method, params) => {
    calls.push({ tabId, method, params });
    return { result: { value: 2 } };
  },
  userScriptsExecute: async () => {
    throw new Error("debugger 成功时不应再走 userScripts");
  },
});
assert.equal(viaDebugger.result, 2);
assert.equal(calls[0].method, "Runtime.evaluate");
assert.match(calls[0].params.expression, /1\+1/);

let userScripts = 0;
const viaUserscripts = await runJsRestricted(3, "document.title", {
  debuggerSend: async () => ({ exceptionDetails: { text: "Content Security Policy blocked the script" } }),
  userScriptsExecute: async (opts) => {
    userScripts += 1;
    assert.equal(opts.world, "USER_SCRIPT");
    assert.match(opts.js[0].code, /document\.title/);
    return [{ result: { ok: true, via: "userScripts", result: "Hello" } }];
  },
});
assert.equal(userScripts, 1);
assert.equal(viaUserscripts.result, "Hello");

const source = readFileSync(resolve(root, "extension/lib/run-js.js"), "utf8");
const dynamicCtor = ["Async", "Function"].join("");
assert.equal(source.includes(dynamicCtor), false);
assert.equal(/\beval\s*\(/.test(source), false);
assert.match(source, /Runtime\.evaluate/);
assert.match(source, /userScriptsExecute/);

console.log("auth scope ok");
