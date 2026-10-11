/**
 * 不可逆动作清单。命中后必须由人确认一次，确认只放行完全相同的参数一次。
 */

export const IRREVERSIBLE_ITEMS = Object.freeze([
  { id: "publish_send", label: "发布 / 发送 / 提交" },
  { id: "delete", label: "删除" },
  { id: "checkout_pay", label: "付款 / 结账页面上的操作" },
]);

export const IRREVERSIBLE_IDS = IRREVERSIBLE_ITEMS.map((item) => item.id);

export function defaultIrreversibleActions() {
  return Object.fromEntries(IRREVERSIBLE_IDS.map((id) => [id, true]));
}

export function normalizeIrreversibleActions(raw) {
  const out = defaultIrreversibleActions();
  if (raw && typeof raw === "object") {
    for (const id of IRREVERSIBLE_IDS) if (typeof raw[id] === "boolean") out[id] = raw[id];
  }
  return out;
}

const PUBLISH_TEXT_RE =
  /(发布|发表|发送|群发|提交订单|确认订单|立即购买|立即下单|确认支付|确认付款|立即支付|去支付|\b(?:publish|post|send|submit\s+order|place\s+(?:your\s+)?order|buy\s+now|pay\s+now|confirm\s+(?:payment|purchase|order)|checkout)\b)/i;
const DELETE_TEXT_RE = /(删除|永久删除|清空|注销|移除|\b(?:delete|remove|erase|destroy)\b)/i;
const CHECKOUT_RE = /(?:^|[./_-])(?:checkout|pay|payment|payments|cashier|billing|purchase|order[-_]?confirm|收银台|支付)(?:$|[./_?#-])/i;

const CLICK_TOOLS = new Set(["click"]);
const PAGE_ACT_TOOLS = new Set(["click", "type", "run_js"]);

function enabledMap(settings) {
  return normalizeIrreversibleActions(settings?.irreversibleActions);
}

function urlPathOf(url) {
  try {
    const parsed = new URL(String(url || ""));
    return { host: parsed.hostname, path: parsed.pathname };
  } catch {
    return { host: "", path: String(url || "") };
  }
}

export function isCheckoutUrl(url) {
  const { host, path } = urlPathOf(url);
  if (!host && !path) return false;
  return CHECKOUT_RE.test(host) || CHECKOUT_RE.test(path);
}

export function matchIrreversible(toolName, args = {}, settings = {}, ctx = {}) {
  const on = enabledMap(settings);
  const item = (id, reason) => {
    if (!on[id]) return null;
    const found = IRREVERSIBLE_ITEMS.find((entry) => entry.id === id);
    return { id, label: found.label, reason };
  };
  const hits = [];
  const buttonText = [args?.text, ctx.elementText].filter((value) => typeof value === "string" && value.trim()).join(" ").slice(0, 200);
  if (CLICK_TOOLS.has(toolName) && buttonText && PUBLISH_TEXT_RE.test(buttonText)) {
    hits.push(item("publish_send", `点击「${buttonText.slice(0, 40)}」`));
  }
  if (CLICK_TOOLS.has(toolName) && buttonText && DELETE_TEXT_RE.test(buttonText)) {
    hits.push(item("delete", `点击「${buttonText.slice(0, 40)}」`));
  }
  const navUrl = toolName === "navigate" ? String(args?.url || "") : "";
  if (navUrl && isCheckoutUrl(navUrl)) hits.push(item("checkout_pay", "打开付款/结账页面"));
  if (PAGE_ACT_TOOLS.has(toolName) && ctx.targetUrl && isCheckoutUrl(ctx.targetUrl)) {
    hits.push(item("checkout_pay", "在付款/结账页面上操作"));
  }
  return hits.find(Boolean) || null;
}
