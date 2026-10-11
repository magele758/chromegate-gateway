/**
 * token 调用的人工确认。页面正文不能打开高权限 scope，这里只看工具名、参数和调用前读到的控件文字。
 */

import { BridgeError, ERROR_CODES } from "./protocol.js";
import { matchIrreversible } from "../trust/irreversible.js";

export function approvalPrincipal(record) {
  return `token:${record?.id || ""}`;
}

export function matchTokenIrreversible(toolName, args = {}, settings = {}, { targetUrl = "", elementText = "" } = {}) {
  return matchIrreversible(toolName, args, settings, { targetUrl, elementText });
}

export function checkTokenCall(toolName, args = {}, { record, settings = {}, targetUrl = "", elementText = "" } = {}) {
  const irreversible = matchTokenIrreversible(toolName, args, settings, { targetUrl, elementText });
  if (!irreversible) return { ok: true, irreversible: null };
  if (record?.skipIrreversible === true) return { ok: true, irreversible, optOut: true };
  return { ok: false, code: ERROR_CODES.CONFIRMATION_REQUIRED, irreversible };
}

export async function enforceTokenGuards(toolName, args = {}, { record, settings = {}, targetUrl = "", elementText = "", approvals, sessionId = "" } = {}) {
  const verdict = checkTokenCall(toolName, args, { record, settings, targetUrl, elementText });
  if (verdict.ok) return { confirmed: false, irreversible: verdict.irreversible?.id || null, optOut: verdict.optOut === true };

  const item = verdict.irreversible;
  const principal = approvalPrincipal(record);
  if (!approvals) {
    throw new BridgeError(ERROR_CODES.CONFIRMATION_REQUIRED, `不可逆操作需用户批准：${item.reason}`, {
      retryable: false,
      details: { item: { id: item.id, label: item.label } },
    });
  }
  if (await approvals.consumeApproved(toolName, args, { principal })) return { confirmed: true, irreversible: item.id, optOut: false };
  if (await approvals.consumeRejected(toolName, args, { principal })) {
    throw new BridgeError(ERROR_CODES.CONFIRMATION_REJECTED, `用户拒绝了这次操作：${item.reason}`, {
      hint: "不要换别的工具绕过。再次用相同参数调用会重新进入待批准队列。",
      details: { item: { id: item.id, label: item.label } },
    });
  }
  const entry = await approvals.enqueue({
    toolName,
    args,
    reason: `外部 Agent「${record?.name || "?"}」：${item.reason}`,
    item,
    principal,
    sessionId: sessionId || "",
  });
  throw new BridgeError(ERROR_CODES.CONFIRMATION_REQUIRED, `不可逆操作需用户批准：${item.reason}`, {
    hint: "已放入待确认队列。请在 ChromeGate Gateway 弹窗里批准，然后用完全相同的参数重试（每次批准只放行一次）。",
    details: { pendingId: entry.id, item: { id: item.id, label: item.label } },
  });
}
