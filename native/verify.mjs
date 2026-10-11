import fs from "node:fs";
import path from "node:path";
import { OBSERVE_TOOLS, STEP_TOOLS } from "../extension/lib/bridge/tools.js";

const ASSERT_KINDS = new Set([
  "identity",
  "stream_integrity",
  "dialog_state",
  "dom_text",
  "dom_attr",
  "no_console_errors",
  "network_count",
  "screenshot",
]);

export function substitute(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
      if (vars[key] == null) throw new Error(`场景变量未赋值：${key}`);
      return String(vars[key]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = substitute(item, vars);
    return out;
  }
  return value;
}

export function getPath(obj, pathStr) {
  const parts = String(pathStr || "").split(".").filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[/^\d+$/.test(part) ? Number(part) : part];
  }
  return current;
}

export function checkIdentity(left, right) {
  if (left == null || right == null || left === "" || right === "") return { ok: false, reason: "身份标识为空", left: left ?? null, right: right ?? null };
  if (String(left) !== String(right)) return { ok: false, reason: "身份标识不一致", left: String(left), right: String(right) };
  return { ok: true, value: String(left) };
}

export function checkContiguous(seqs) {
  if (!seqs.length) return { ok: false, reason: "序号为空" };
  for (let i = 0; i < seqs.length; i += 1) {
    if (!Number.isInteger(seqs[i])) return { ok: false, reason: "序号不是整数", seqs };
    if (i > 0 && seqs[i] !== seqs[i - 1] + 1) return { ok: false, reason: "序号不连续", seqs };
  }
  return { ok: true, count: seqs.length };
}

export function checkStreamIntegrity({ domSeqs, sseSeqs }) {
  const dom = checkContiguous(domSeqs);
  if (!dom.ok) return { ...dom, side: "dom" };
  const sse = checkContiguous(sseSeqs);
  if (!sse.ok) return { ...sse, side: "sse" };
  if (domSeqs.length !== sseSeqs.length || domSeqs.some((value, index) => value !== sseSeqs[index])) {
    return { ok: false, reason: "DOM 序号与 SSE 序号不一致", domSeqs, sseSeqs, domCount: domSeqs.length, sseCount: sseSeqs.length };
  }
  return { ok: true, count: domSeqs.length };
}

export function checkDialogState({ nodes, open, textIncludes }) {
  const visible = (nodes || []).filter((node) => !node.hidden);
  const isOpen = visible.length > 0;
  if (Boolean(open) !== isOpen) {
    return { ok: false, reason: open ? "弹窗未打开" : "弹窗仍然打开", open: isOpen, count: visible.length };
  }
  if (open && textIncludes) {
    const text = visible.map((node) => node.text || "").join("\n");
    if (!text.includes(textIncludes)) return { ok: false, reason: "弹窗文案不匹配", text };
  }
  return { ok: true, open: isOpen };
}

function numbersFrom(nodes, attr) {
  return (nodes || []).map((node) => Number(attr ? node?.attrs?.[attr] : node?.text));
}

async function observe(phase, wrapped, tabId, tool, args) {
  if (!OBSERVE_TOOLS.includes(tool)) throw new Error(`断言不能调用 ${tool}`);
  const response = await wrapped(phase, tool, { tabId, ...args });
  if (!response?.ok) {
    const error = new Error(response?.error?.message || `${tool} 失败`);
    error.response = response;
    throw error;
  }
  return response;
}

async function evaluateAssert(step, { phase, wrapped, saved, tabId }) {
  const kind = step.assert;
  if (!ASSERT_KINDS.has(kind)) return { ok: false, reason: `未知断言：${kind}` };
  if (kind === "identity") {
    const left = getPath(saved[step.left], step.path);
    const right = getPath(saved[step.right], step.path);
    return checkIdentity(left, right);
  }
  if (!Number.isInteger(tabId)) return { ok: false, reason: "断言没有目标标签。先 navigate。" };
  if (kind === "stream_integrity") {
    const dom = await observe(phase, wrapped, tabId, "query_dom", { selector: step.selector });
    const net = await observe(phase, wrapped, tabId, "read_network", {});
    const domSeqs = numbersFrom(dom.result?.nodes, step.attr || "data-seq");
    const sseSeqs = (net.result?.sse || [])
      .filter((event) => !step.sseUrlIncludes || String(event.url || "").includes(step.sseUrlIncludes))
      .map((event) => event.seq);
    return checkStreamIntegrity({ domSeqs, sseSeqs });
  }
  if (kind === "dialog_state") {
    const dom = await observe(phase, wrapped, tabId, "query_dom", { selector: step.selector });
    return checkDialogState({ nodes: dom.result?.nodes, open: step.open === true, textIncludes: step.textIncludes });
  }
  if (kind === "dom_text" || kind === "dom_attr") {
    const dom = await observe(phase, wrapped, tabId, "query_dom", { selector: step.selector });
    const node = dom.result?.nodes?.[0];
    const actual = kind === "dom_attr" ? node?.attrs?.[step.attr] : node?.text;
    if (step.equals != null && String(actual ?? "") !== String(step.equals)) return { ok: false, reason: "DOM 不匹配", expected: step.equals, actual: actual ?? null };
    if (step.includes && !String(actual ?? "").includes(step.includes)) return { ok: false, reason: "DOM 未包含期望文本", expected: step.includes, actual: actual ?? null };
    if (actual == null) return { ok: false, reason: "没有匹配到元素", selector: step.selector };
    return { ok: true, actual };
  }
  if (kind === "no_console_errors") {
    const consoleLog = await observe(phase, wrapped, tabId, "read_console", {});
    const errors = (consoleLog.result?.messages || []).filter((message) => message.level === "error");
    if (errors.length) return { ok: false, reason: "存在 console error", errors };
    return { ok: true };
  }
  if (kind === "network_count") {
    const net = await observe(phase, wrapped, tabId, "read_network", {});
    const matched = (net.result?.requests || []).filter((request) => String(request.url || "").includes(step.urlIncludes || ""));
    if (matched.length !== Number(step.count)) {
      return { ok: false, reason: "网络请求计数不符", expected: step.count, actual: matched.length, urls: matched.map((request) => request.url) };
    }
    return { ok: true, count: matched.length };
  }
  if (kind === "screenshot") {
    const shot = await observe(phase, wrapped, tabId, "screenshot", {});
    const bytes = shot.result?.bytes || 0;
    const minBytes = Number(step.minBytes || 32);
    if (bytes < minBytes) return { ok: false, reason: "截图过小", bytes, minBytes };
    return { ok: true, bytes, response: shot };
  }
  return { ok: false, reason: `未处理的断言：${kind}` };
}

function slug(name) {
  return String(name || "scenario").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "scenario";
}

export function renderEvidence({ scenario, failure, evidence, calls }) {
  const verdict = failure?.verdict || {};
  const lines = [
    `# ChromeGate verify 失败：${scenario?.name || "scenario"}`,
    "",
    `- 时间：${new Date().toISOString()}`,
    `- 步骤：${failure?.step?.assert || failure?.step?.tool || "(未知)"}`,
    `- 原因：${verdict.reason || failure?.verdict?.reason || "失败"}`,
    `- 自愈：否（断言失败后停止，不再改页面）`,
    "",
    "## 判定",
    "",
    "```json",
    JSON.stringify(verdict, null, 2),
    "```",
    "",
    "## 调用",
    "",
    "```json",
    JSON.stringify(calls.map(({ phase, tool }) => ({ phase, tool })), null, 2),
    "```",
    "",
    "## DOM",
    "",
    "```json",
    JSON.stringify(evidence.dom ?? null, null, 2).slice(0, 8000),
    "```",
    "",
    "## Console",
    "",
    "```json",
    JSON.stringify(evidence.console ?? null, null, 2).slice(0, 8000),
    "```",
    "",
    "## Network",
    "",
    "```json",
    JSON.stringify(evidence.network ?? null, null, 2).slice(0, 8000),
    "```",
    "",
    "## Screenshot",
    "",
    evidence.screenshotFile ? evidence.screenshotFile : "（没有截图）",
    "",
  ];
  return lines.join("\n");
}

function writePack(dir, scenario, failure, evidence, calls) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = `${slug(scenario?.name)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (evidence.screenshotBase64) {
    evidence.screenshotFile = path.join(dir, `${base}.jpg`);
    fs.writeFileSync(evidence.screenshotFile, Buffer.from(evidence.screenshotBase64, "base64"), { mode: 0o600 });
  }
  const file = path.join(dir, `${base}.md`);
  fs.writeFileSync(file, renderEvidence({ scenario, failure, evidence, calls }), { mode: 0o600 });
  return file;
}

async function collectEvidence(wrapped, tabId, evidence) {
  if (!Number.isInteger(tabId)) return;
  const dom = await observe("evidence", wrapped, tabId, "query_dom", { selector: "body" }).catch((err) => ({ error: err.message }));
  evidence.dom = dom.result || dom;
  const consoleLog = await observe("evidence", wrapped, tabId, "read_console", {}).catch((err) => ({ error: err.message }));
  evidence.console = consoleLog.result || consoleLog;
  const net = await observe("evidence", wrapped, tabId, "read_network", {}).catch((err) => ({ error: err.message }));
  evidence.network = net.result || net;
  const shot = await observe("evidence", wrapped, tabId, "screenshot", {}).catch(() => null);
  const artifact = (shot?.artifacts || []).find((item) => item.encoding === "base64");
  evidence.screenshotBase64 = artifact?.data || null;
}

export function loadScenario(file) {
  const scenario = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!scenario || !Array.isArray(scenario.steps)) throw new Error("场景必须包含 steps 数组。");
  return scenario;
}

export function dryRunScenario(scenario) {
  const tools = [];
  for (const step of scenario.steps || []) {
    if (step.assert) {
      if (!ASSERT_KINDS.has(step.assert)) throw new Error(`未知断言：${step.assert}`);
      continue;
    }
    if (!STEP_TOOLS.includes(step.tool)) throw new Error(`工具不在白名单：${step.tool}`);
    tools.push(step.tool);
  }
  return { ok: true, name: scenario.name || "", tools, asserts: (scenario.steps || []).filter((step) => step.assert).map((step) => step.assert) };
}

export async function runScenario(scenario, { call, vars = {}, outboxDir, collectOnFailure = true } = {}) {
  const merged = { ...(scenario.vars || {}), ...vars };
  const calls = [];
  const saved = {};
  let tabId = Number.isInteger(scenario.tabId) ? scenario.tabId : null;
  const evidence = {};

  async function wrapped(phase, tool, args) {
    if (phase === "step" && !STEP_TOOLS.includes(tool)) throw new Error(`工具不在白名单：${tool}`);
    if (phase !== "step" && !OBSERVE_TOOLS.includes(tool)) throw new Error(`断言不能调用 ${tool}`);
    calls.push({ phase, tool, args });
    return call({ v: 1, id: `v${calls.length}`, tool, args });
  }

  let failure = null;
  for (const rawStep of scenario.steps || []) {
    const step = substitute(rawStep, merged);
    if (step.assert && step.tool) {
      failure = { step, verdict: { ok: false, reason: "同一步不能既是工具又是断言" }, blocked: true };
      break;
    }
    if (step.assert) {
      let verdict;
      try {
        verdict = await evaluateAssert(step, { phase: "assert", wrapped, saved, tabId });
      } catch (err) {
        verdict = { ok: false, reason: err?.message || String(err) };
      }
      if (!verdict.ok) {
        failure = { step, verdict };
        break;
      }
      continue;
    }
    if (!STEP_TOOLS.includes(step.tool)) {
      failure = { step, verdict: { ok: false, reason: `工具不在白名单：${step.tool}` }, blocked: true };
      break;
    }
    const args = { ...(step.args || {}) };
    if (tabId && args.tabId == null && step.tool !== "list_tabs") args.tabId = tabId;
    let response;
    try {
      response = await wrapped("step", step.tool, args);
    } catch (err) {
      failure = { step, verdict: { ok: false, reason: err?.message || String(err) } };
      break;
    }
    if (!response?.ok) {
      failure = { step, verdict: { ok: false, reason: response?.error?.message || "工具失败", code: response?.error?.code || null } };
      break;
    }
    if (step.tool === "navigate" && Number.isInteger(response.result?.tabId)) tabId = response.result.tabId;
    if (step.save) saved[step.save] = response.result;
  }

  if (!failure) return { ok: true, calls, saved, healed: false };
  if (collectOnFailure && !failure.blocked) await collectEvidence(wrapped, tabId, evidence);
  const file = outboxDir ? writePack(outboxDir, scenario, failure, evidence, calls) : null;
  return { ok: false, failure, calls, saved, file, healed: false };
}
