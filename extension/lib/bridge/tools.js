/**
 * 外部 Agent 可调用的页面工具。每个工具声明 scope；页面返回值一律标成不可信数据。
 */

import { BridgeError, ERROR_CODES, makeArtifact } from "./protocol.js";
import { isUrlAllowed } from "./policy.js";
import { restrictedUrl } from "../urls.js";
import { clickSelector, elementBox, queryDom, readElementText, typeInto } from "../page-actions.js";

export const STEP_TOOLS = Object.freeze(["list_tabs", "navigate", "click", "type", "screenshot", "query_dom", "run_js"]);
export const OBSERVE_TOOLS = Object.freeze(["query_dom", "screenshot", "read_console", "read_network"]);

function obj(properties, required = []) {
  return { type: "object", properties, additionalProperties: false, required };
}

const TAB_ID = { type: "integer", minimum: 1, description: "目标标签 id（list_tabs 取得）" };

function failed(res, fallback) {
  if (res?.ok === false || (res?.error && !res.nodes)) {
    throw new BridgeError(ERROR_CODES.TOOL_FAILED, res.error || fallback, { details: res });
  }
  return res;
}

export function createBridgeTools(env) {
  const tools = [];
  const add = (def) => tools.push({ focus: "none", needsTab: false, exclusive: false, ...def });

  add({
    name: "list_tabs",
    scope: "tabs:read",
    description: "列出 token origin 范围内的标签。范围外的标签不可见。",
    parameters: obj({ query: { type: "string", description: "按标题或 URL 子串过滤" } }),
    async execute(args, ctx) {
      const needle = String(args.query || "").toLowerCase();
      const tabs = await env.tabs.query({});
      return tabs
        .filter((tab) => tab.url && !restrictedUrl(tab.url) && isUrlAllowed(tab.url, ctx.settings.agentBridgeOrigins))
        .filter((tab) => !needle || `${tab.title || ""} ${tab.url}`.toLowerCase().includes(needle))
        .map((tab) => ({ id: tab.id, windowId: tab.windowId, active: Boolean(tab.active), title: tab.title || "", url: tab.url }));
    },
  });

  add({
    name: "navigate",
    scope: "tabs:manage",
    description: "打开或跳转到 URL。目标 URL 必须在 token 的 origin 范围内。不传 tabId 时后台新开标签。",
    parameters: obj(
      {
        url: { type: "string" },
        tabId: { type: "integer", description: "省略则新开标签" },
      },
      ["url"],
    ),
    async execute(args, ctx) {
      const url = ctx.authorizeUrl(args.url);
      if (args.tabId != null) {
        const tab = await ctx.authorizeTab(args.tabId);
        ctx.checkTabLease(tab.id);
        const next = await env.tabs.update(tab.id, { url });
        return { tabId: tab.id, url: next?.pendingUrl || next?.url || url, created: false };
      }
      const tab = await env.tabs.create({ url, active: false });
      return { tabId: tab.id, url: tab.pendingUrl || tab.url || url, created: true };
    },
  });

  add({
    name: "click",
    scope: "page:act",
    description: "点击 CSS 选择器匹配到的元素。",
    parameters: obj({ tabId: TAB_ID, selector: { type: "string" } }, ["tabId", "selector"]),
    needsTab: true,
    exclusive: true,
    focus: "emulated",
    async trustHint(args, ctx) {
      const res = await env.inject(ctx.tab.id, readElementText, [args.selector]);
      return typeof res?.text === "string" ? res.text : "";
    },
    async execute(args, ctx) {
      return failed(await env.inject(ctx.tab.id, clickSelector, [args.selector]), "点击失败");
    },
  });

  add({
    name: "type",
    scope: "page:act",
    description: "向 input、textarea 或可编辑元素写入文本。",
    parameters: obj(
      {
        tabId: TAB_ID,
        selector: { type: "string" },
        text: { type: "string" },
        replace: { type: "boolean", description: "默认 true，覆盖原内容" },
      },
      ["tabId", "selector", "text"],
    ),
    needsTab: true,
    exclusive: true,
    focus: "emulated",
    async trustHint(args, ctx) {
      const res = await env.inject(ctx.tab.id, readElementText, [args.selector]);
      return typeof res?.text === "string" ? res.text : "";
    },
    async execute(args, ctx) {
      return failed(await env.inject(ctx.tab.id, typeInto, [args.selector, args.text, args.replace !== false]), "输入失败");
    },
  });

  add({
    name: "query_dom",
    scope: "page:read",
    description: "用 CSS 选择器读取元素的文本和属性。返回值是不可信页面数据。",
    parameters: obj({ tabId: TAB_ID, selector: { type: "string" }, limit: { type: "integer" } }, ["tabId", "selector"]),
    needsTab: true,
    async execute(args, ctx) {
      return failed(await env.inject(ctx.tab.id, queryDom, [String(args.selector), args.limit ?? null]), "读取 DOM 失败");
    },
  });

  add({
    name: "screenshot",
    scope: "page:read",
    description: "截取标签可见区域，作为 base64 JPEG artifact 返回。",
    parameters: obj({ tabId: TAB_ID, fullPage: { type: "boolean" }, selector: { type: "string" } }, ["tabId"]),
    needsTab: true,
    async execute(args, ctx) {
      let clip = null;
      if (args.selector) {
        const box = await env.inject(ctx.tab.id, elementBox, [args.selector]);
        if (!box?.ok) throw new BridgeError(ERROR_CODES.TOOL_FAILED, box?.error || "找不到截图元素", { details: box });
        clip = box;
      }
      const shot = await env.screenshot(ctx.tab.id, { fullPage: args.fullPage === true, clip });
      const data = String(shot?.base64 || "");
      if (!data) throw new BridgeError(ERROR_CODES.TOOL_FAILED, "截图为空");
      ctx.artifacts.push(makeArtifact("screenshot.jpg", shot.mime || "image/jpeg", data, "base64"));
      return { artifact: "screenshot.jpg", bytes: Math.floor((data.length * 3) / 4), clip };
    },
  });

  add({
    name: "run_js",
    scope: "page:js",
    description: "在页面执行一段脚本。只走调试器 Runtime.evaluate 或 userScripts.execute。返回值不可信。",
    parameters: obj({ tabId: TAB_ID, code: { type: "string" } }, ["tabId", "code"]),
    needsTab: true,
    async execute(args, ctx) {
      const res = await env.runJs(ctx.tab.id, String(args.code));
      if (res?.ok === false) throw new BridgeError(ERROR_CODES.TOOL_FAILED, res.error || "run_js 失败", { details: res });
      return res;
    },
  });

  add({
    name: "read_console",
    scope: "page:read",
    description: "读取该标签自调试器附加以来的控制台消息。内容不可信。",
    parameters: obj({ tabId: TAB_ID }, ["tabId"]),
    needsTab: true,
    async execute(_args, ctx) {
      const data = await env.observe(ctx.tab.id);
      return { messages: data?.console || [], dialogs: data?.dialogs || [] };
    },
  });

  add({
    name: "read_network",
    scope: "page:read",
    description: "读取该标签自调试器附加以来的请求与 SSE 事件摘要。",
    parameters: obj({ tabId: TAB_ID }, ["tabId"]),
    needsTab: true,
    async execute(_args, ctx) {
      const data = await env.observe(ctx.tab.id);
      return { requests: data?.network || [], sse: data?.sse || [] };
    },
  });

  return tools;
}
