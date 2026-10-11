/**
 * 注入到页面的固定函数。chrome.scripting.executeScript 会序列化函数体。
 * 页面内容只作为数据返回，不能改变 token 的 scope。
 */

function pageDocument() {
  return globalThis.document;
}

function viewEvent(el) {
  return el?.ownerDocument?.defaultView?.Event || globalThis.Event;
}

function isSecret(el) {
  return String(el?.getAttribute?.("type") || "").toLowerCase() === "password";
}

function visibleText(el) {
  if (!el || isSecret(el)) return "";
  return String(el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 400);
}

export function readElementText(selector) {
  const el = pageDocument().querySelector(String(selector || ""));
  if (!el) return { ok: false, error: "not-found" };
  return {
    ok: true,
    tag: el.tagName,
    type: el.getAttribute?.("type") || "",
    text: visibleText(el).slice(0, 200),
  };
}

export function queryDom(selector, limit) {
  const document = pageDocument();
  const max = Math.min(Number(limit) || 20, 50);
  let nodes;
  try {
    nodes = [...document.querySelectorAll(String(selector || ""))].slice(0, max);
  } catch (err) {
    return { error: err?.message || String(err) };
  }
  const keep = ["role", "aria-modal", "aria-hidden", "href", "type", "name"];
  return {
    selector: String(selector || ""),
    nodes: nodes.map((el) => {
      const attrs = {};
      for (const attr of [...(el.attributes || [])]) {
        if (attr.name.startsWith("data-") || keep.includes(attr.name)) attrs[attr.name] = String(attr.value || "").slice(0, 200);
      }
      let hidden = Boolean(el.hidden) || attrs["aria-hidden"] === "true";
      try {
        const style = globalThis.getComputedStyle?.(el);
        if (style && (style.display === "none" || style.visibility === "hidden")) hidden = true;
      } catch {
        /* 没有计算样式时只看属性和 hidden */
      }
      return {
        tag: String(el.tagName || "").toLowerCase(),
        id: el.id || "",
        text: visibleText(el),
        attrs,
        hidden,
      };
    }),
  };
}

export function clickSelector(selector) {
  const el = pageDocument().querySelector(String(selector || ""));
  if (!el) return { ok: false, error: "not-found" };
  const rect = el.getBoundingClientRect?.() || { x: 0, y: 0, width: 0, height: 0 };
  if (typeof el.click === "function") el.click();
  return {
    ok: true,
    tag: el.tagName,
    text: visibleText(el).slice(0, 200),
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

export function typeInto(selector, text, replace) {
  const el = pageDocument().querySelector(String(selector || ""));
  if (!el) return { ok: false, error: "not-found" };
  const incoming = String(text ?? "");
  if (typeof el.focus === "function") el.focus();
  const secret = isSecret(el);
  if ("value" in el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    const proto = Object.getPrototypeOf(el);
    const parent = proto ? Object.getPrototypeOf(proto) : null;
    const setter =
      Object.getOwnPropertyDescriptor(proto, "value")?.set ||
      (parent ? Object.getOwnPropertyDescriptor(parent, "value")?.set : undefined);
    const next = replace === false ? `${el.value || ""}${incoming}` : incoming;
    if (setter) setter.call(el, next);
    else el.value = next;
    const EventCtor = viewEvent(el);
    el.dispatchEvent(new EventCtor("input", { bubbles: true }));
    el.dispatchEvent(new EventCtor("change", { bubbles: true }));
    return {
      ok: true,
      length: String(el.value || "").length,
      matches: el.value === next,
      ...(secret ? {} : { value: el.value }),
    };
  }
  if (el.isContentEditable) {
    const next = replace === false ? `${el.textContent || ""}${incoming}` : incoming;
    el.textContent = next;
    el.dispatchEvent(new viewEvent(el)("input", { bubbles: true }));
    return { ok: true, length: next.length, matches: el.textContent === next, value: el.textContent };
  }
  return { ok: false, error: "not-editable" };
}

export function elementBox(selector) {
  const el = pageDocument().querySelector(String(selector || ""));
  if (!el || typeof el.getBoundingClientRect !== "function") return { ok: false, error: "not-found" };
  const rect = el.getBoundingClientRect();
  return { ok: true, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
