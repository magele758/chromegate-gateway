/**
 * ChromeGate 控制入口。每次网关调用都校验 token、scope 和 origin。
 * 无 token 的调用一律拒绝。页面工具的返回值标为不可信，不会回写 token。
 */

import { createDefaultEnv } from "../browser-env.js";
import {
  BRIDGE_PROTOCOL,
  BridgeError,
  ERROR_CODES,
  errorResponse,
  okResponse,
  requestFingerprint,
  validateRequest,
} from "./protocol.js";
import { isUrlAllowed } from "./policy.js";
import { restrictedUrl } from "../urls.js";
import { createBridgeTools } from "./tools.js";
import { publicTokenInfo, requireScope, scopeAllows, tokenUrlAllowed, verifyToken } from "./auth.js";
import { auditEntry, originOfUrl } from "./audit.js";
import { createEventBus, installEventSources } from "./events.js";
import { createKeyedQueue, createTabLeases, leaseGuarded, openedTabIds, queueKeys } from "./leases.js";
import { createJobStore } from "./jobs.js";
import { SESSION_META, SESSION_META_TOOLS, createSessionMeta, jobView } from "./session-tools.js";
import { enforceTokenGuards } from "./trust-guard.js";

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const AUDIT_MAX = 100;
const PAGE_DATA_TOOLS = new Set(["query_dom", "read_console", "read_network", "run_js", "click", "type"]);

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return String(url || "");
  }
}

function checkArgs(tool, args) {
  const schema = tool.parameters || {};
  const props = schema.properties || {};
  for (const key of Object.keys(args)) {
    if (!(key in props)) throw new BridgeError(ERROR_CODES.BAD_ARGS, `未知参数：${key}（工具 ${tool.name}）`);
  }
  for (const key of schema.required || []) {
    if (args[key] == null || args[key] === "") throw new BridgeError(ERROR_CODES.BAD_ARGS, `缺少参数：${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const type = props[key]?.type;
    if (value == null || !type) continue;
    const ok =
      (type === "string" && typeof value === "string") ||
      (type === "integer" && Number.isInteger(value)) ||
      (type === "number" && typeof value === "number") ||
      (type === "boolean" && typeof value === "boolean") ||
      (type === "array" && Array.isArray(value)) ||
      (type === "object" && typeof value === "object" && !Array.isArray(value));
    if (!ok) throw new BridgeError(ERROR_CODES.BAD_ARGS, `参数 ${key} 类型应为 ${type}。`);
  }
}

function stampUntrusted(toolName, result) {
  if (!PAGE_DATA_TOOLS.has(toolName)) return result;
  if (result && typeof result === "object" && !Array.isArray(result)) return { ...result, untrusted: true };
  return { untrusted: true, value: result ?? null };
}

export function createBridge(env = createDefaultEnv()) {
  const tools = createBridgeTools(env);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const cache = new Map();
  const audit = [];
  const auditLog = env.auditLog || null;
  const loadTokens = env.getAgentTokens || (async () => []);
  const now = () => env.now?.() ?? Date.now();
  const events = env.events || createEventBus({ loadTokens, now });
  const leases = createTabLeases({ now, groups: env.tabGroups || null });
  const queue = createKeyedQueue();
  const jobs = createJobStore({ storage: env.sessionStorage || null, now });
  const approvals = env.approvals || null;

  const describe = (tool) => ({
    name: tool.name,
    description: tool.description,
    focus: tool.focus,
    needsTab: tool.needsTab,
    ...(tool.scope ? { scope: tool.scope } : {}),
    parameters: tool.parameters,
  });
  const visibleTools = (auth) => tools.filter((tool) => scopeAllows(auth.record, tool.scope));
  const metaTools = [
    {
      name: "list_tools",
      description: "列出当前 token 可用的工具。",
      focus: "none",
      needsTab: false,
      parameters: { type: "object", properties: {}, additionalProperties: false, required: [] },
    },
    {
      name: "job_status",
      description: "查询 async 请求的状态。",
      focus: "none",
      needsTab: false,
      parameters: { type: "object", properties: { jobId: { type: "string" } }, additionalProperties: false, required: ["jobId"] },
    },
    {
      name: "audit_log",
      description: "最近的调用审计（参数只有脱敏摘要）。只返回本 token 的记录。",
      focus: "none",
      needsTab: false,
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", description: "默认 50，最大 500" } },
        additionalProperties: false,
        required: [],
      },
    },
    ...SESSION_META_TOOLS,
  ];
  const metaByName = new Map(metaTools.map((tool) => [tool.name, tool]));

  async function authenticate(session) {
    const record = await verifyToken(await loadTokens(), session?.token, now());
    return {
      record,
      sessionId: String(session?.sessionId || "") || null,
      agentName: String(session?.agentName || "").slice(0, 80) || null,
    };
  }

  const keyFor = (auth, id) => `${auth.record.id}\u0000${id}`;

  async function hello({ session } = {}) {
    if (!session) {
      return {
        protocol: BRIDGE_PROTOCOL,
        name: "chromegate-bridge",
        extensionVersion: env.extensionVersion?.() ?? null,
        enabled: false,
        tools: [],
        errorCodes: Object.keys(ERROR_CODES),
      };
    }
    const auth = await authenticate(session);
    return {
      protocol: BRIDGE_PROTOCOL,
      name: "chromegate-bridge",
      extensionVersion: env.extensionVersion?.() ?? null,
      enabled: true,
      agent: publicTokenInfo(auth.record, now()),
      allowedOrigins: auth.record.origins,
      errorCodes: Object.keys(ERROR_CODES),
      tools: [...metaTools, ...visibleTools(auth)].map(describe),
    };
  }

  function originDenied(what, url, auth) {
    return new BridgeError(ERROR_CODES.ORIGIN_NOT_ALLOWED, `${what} 的 origin 不在 token「${auth.record.name}」的范围：${originOf(url)}`, {
      hint: "在 ChromeGate 弹窗新建一个 origin 范围包含它的 token。",
      details: { origin: originOf(url), url },
    });
  }

  function authorizeUrl(url, auth) {
    const value = String(url || "");
    if (restrictedUrl(value) || !tokenUrlAllowed(auth.record, value) || !isUrlAllowed(value, auth.record.origins)) {
      throw originDenied("URL", value, auth);
    }
    return value;
  }

  async function authorizeTab(tabId, auth) {
    if (!Number.isInteger(tabId) || tabId < 1) throw new BridgeError(ERROR_CODES.BAD_ARGS, "tabId 必须是正整数。");
    let tab;
    try {
      tab = await env.tabs.get(tabId);
    } catch (err) {
      throw new BridgeError(ERROR_CODES.TAB_NOT_FOUND, `找不到标签 ${tabId}：${err?.message || err}`);
    }
    if (!tab?.url || restrictedUrl(tab.url) || !tokenUrlAllowed(auth.record, tab.url)) {
      if (!tab) throw new BridgeError(ERROR_CODES.TAB_NOT_FOUND, `找不到标签 ${tabId}`);
      if (restrictedUrl(tab.url)) throw new BridgeError(ERROR_CODES.TAB_RESTRICTED, `受限页：${tab.url || "(空)"}`);
      throw originDenied(`标签 ${tabId}`, tab.url, auth);
    }
    return tab;
  }

  function withTimeout(promise, ms, tool) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new BridgeError(ERROR_CODES.TIMEOUT, `${tool} 超时（${ms}ms）。`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  const owner = (auth) => ({ sessionId: auth.sessionId, agentId: auth.record.id, agentName: auth.agentName || auth.record.name });
  const sessionMeta = createSessionMeta({
    events,
    leases,
    owner,
    authorizeTab: (tabId, auth) => authorizeTab(tabId, auth),
  });

  function record(entry, req, auth, origin) {
    audit.push(entry);
    if (audit.length > AUDIT_MAX) audit.shift();
    if (!auditLog) return;
    auditLog
      .append(
        auditEntry({
          ts: entry.ts,
          agent: auth.record.name,
          agentId: auth.record.id,
          sessionId: auth.sessionId,
          tool: req?.tool,
          origin,
          args: req?.args,
          ok: entry.ok,
          code: entry.code,
          ms: entry.ms,
          confirmed: entry.trust?.confirmed,
          irreversible: entry.trust?.irreversible,
          optOut: entry.trust?.optOut,
        }),
      )
      .catch(() => {});
  }

  function prune() {
    const ts = now();
    for (const [id, entry] of cache) {
      if (entry.done && ts - entry.at > CACHE_TTL_MS) cache.delete(id);
    }
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  async function execute(req, settings, auth) {
    const started = now();
    const meta = { tool: req.tool };
    const artifacts = [];
    let tabId = null;
    let origin = originOfUrl(req.args?.url);
    let trust = null;
    try {
      if (req.tool === "list_tools") {
        return okResponse(req.id, { tools: [...metaTools, ...visibleTools(auth)].map(describe), agent: publicTokenInfo(auth.record, now()) }, { meta: { ...meta, ms: 0 } });
      }
      if (req.tool === "audit_log") {
        checkArgs(metaByName.get("audit_log"), req.args);
        const entries = auditLog ? await auditLog.list({ agentId: auth.record.id, limit: Math.min(req.args.limit || 50, 500) }) : [];
        return okResponse(req.id, { entries }, { meta });
      }
      if (req.tool === "job_status") {
        checkArgs(metaByName.get("job_status"), req.args);
        const job = await jobs.get(keyFor(auth, req.args.jobId));
        if (!job) throw new BridgeError(ERROR_CODES.JOB_NOT_FOUND, `没有任务 ${req.args.jobId}。`);
        return okResponse(req.id, jobView(job), { meta });
      }
      if (SESSION_META.has(req.tool)) {
        checkArgs(metaByName.get(req.tool), req.args);
        return okResponse(req.id, await sessionMeta(req.tool, req.args, auth, settings), { meta });
      }
      const tool = byName.get(req.tool);
      if (!tool) throw new BridgeError(ERROR_CODES.UNKNOWN_TOOL, `未知工具：${req.tool}`, { hint: "用 list_tools 查看可用工具。" });
      requireScope(auth.record, tool.scope, tool.name);
      checkArgs(tool, req.args);
      const toolSettings = { ...settings, agentBridgeOrigins: auth.record.origins };
      const ctx = {
        settings: toolSettings,
        artifacts,
        meta,
        tab: null,
        session: {
          agentId: auth.record.id,
          agentName: auth.record.name,
          sessionId: auth.sessionId,
          tokenId: auth.record.id,
        },
        authorizeTab: (id) => authorizeTab(id, auth),
        authorizeUrl: (url) => authorizeUrl(url, auth),
        checkTabLease: (id) => leases.check(id, owner(auth)),
      };
      const run = async () => {
        if (tool.needsTab) {
          ctx.tab = await authorizeTab(req.args.tabId, auth);
          tabId = ctx.tab.id;
          meta.tabId = tabId;
          origin = originOfUrl(ctx.tab.url);
          if (leaseGuarded(tool)) leases.check(tabId, owner(auth));
        } else if (tool.name === "navigate" && req.args.tabId != null) {
          const target = await authorizeTab(req.args.tabId, auth);
          leases.check(target.id, owner(auth));
          origin = originOfUrl(target.url);
        }
        let elementText = "";
        if (typeof tool.trustHint === "function") {
          const hinted = await tool.trustHint(req.args, ctx);
          if (typeof hinted === "string") elementText = hinted;
        }
        trust = await enforceTokenGuards(tool.name, req.args, {
          record: auth.record,
          settings,
          targetUrl: ctx.tab?.url || req.args?.url || "",
          elementText,
          approvals,
          sessionId: auth.sessionId,
        });
        return stampUntrusted(tool.name, await tool.execute(req.args, ctx));
      };
      const guarded = tool.exclusive ? () => queue.run(queueKeys(tool, req.args, tool.needsTab ? req.args.tabId : null), run) : run;
      const result = await withTimeout(guarded(), req.timeoutMs, req.tool);
      await leases.adopt(openedTabIds(tool.name, result), owner(auth)).catch(() => {});
      meta.ms = now() - started;
      if (trust?.confirmed) meta.confirmed = true;
      record({ ts: started, id: req.id, tool: req.tool, tabId, ok: true, ms: meta.ms, trust }, req, auth, origin);
      return okResponse(req.id, result, { artifacts, meta });
    } catch (err) {
      meta.ms = now() - started;
      if (tabId) meta.tabId = tabId;
      const res = errorResponse(req.id, err, { meta });
      record({ ts: started, id: req.id, tool: req.tool, tabId, ok: false, code: res.error.code, ms: meta.ms, trust }, req, auth, origin);
      return res;
    }
  }

  async function call(rawReq, { session } = {}) {
    let req;
    try {
      req = validateRequest(rawReq);
    } catch (err) {
      return errorResponse(rawReq?.id, err);
    }
    if (!session?.token) {
      return errorResponse(req.id, new BridgeError(ERROR_CODES.UNAUTHORIZED, "ChromeGate 只接受带 token 的调用。", { retryable: false }));
    }
    let settings;
    try {
      settings = await env.getSettings();
    } catch (err) {
      return errorResponse(req.id, err);
    }
    let auth;
    try {
      auth = await authenticate(session);
    } catch (err) {
      return errorResponse(req.id, err);
    }
    prune();
    const fp = requestFingerprint(req);
    const key = keyFor(auth, req.id);
    const hit = cache.get(key);
    if (hit) {
      if (hit.fp !== fp) {
        return errorResponse(req.id, new BridgeError(ERROR_CODES.ID_CONFLICT, "相同 id 的请求内容不同；请换新 id。", { retryable: false }));
      }
      const res = await hit.promise;
      return { ...res, meta: { ...res.meta, replayed: true } };
    }
    const entry = { fp, at: now(), done: false };
    const promise = execute(req, settings, auth).then((res) => {
      entry.done = true;
      entry.at = now();
      if (!res.ok && res.error.retryable) cache.delete(key);
      return res;
    });
    entry.promise = promise;
    cache.set(key, entry);
    if (req.async && !["list_tools", "job_status", "audit_log", ...SESSION_META].includes(req.tool)) {
      jobs.start(key, { tool: req.tool, sessionId: auth.sessionId, agentId: auth.record.id });
      promise.then((res) => jobs.finish(key, res));
      const ack = okResponse(req.id, { jobId: req.id, status: "running" }, { meta: { async: true, tool: req.tool } });
      entry.promise = Promise.resolve(ack);
      return ack;
    }
    return promise;
  }

  return {
    hello,
    call,
    tools,
    audit: () => [...audit],
    events,
    leases,
    jobs,
    approvals,
    closeSession(sessionId) {
      events.closeSession(sessionId);
      leases.releaseSession(sessionId);
    },
    closeAllSessions() {
      events.closeAll();
      leases.clear();
    },
  };
}

let installed = null;

export function installBridge(env) {
  if (installed) return installed;
  const bridge = createBridge(env);
  installed = bridge;
  installEventSources(bridge.events, chrome);
  chrome.tabs?.onRemoved?.addListener?.((tabId) => bridge.leases.dropTab(tabId));
  globalThis.__cg = {
    protocol: BRIDGE_PROTOCOL,
    hello: () => bridge.hello(),
    call: (request, session) => bridge.call(request, { session }),
  };
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id) return false;
    if (msg?.type === "cg.bridge.hello") {
      bridge.hello().then(sendResponse).catch((err) => sendResponse(errorResponse(null, err)));
      return true;
    }
    if (msg?.type === "cg.bridge.call") {
      bridge.call(msg.request, { session: msg.session }).then(sendResponse);
      return true;
    }
    return false;
  });
  return bridge;
}

export function getBridge() {
  return installed;
}
