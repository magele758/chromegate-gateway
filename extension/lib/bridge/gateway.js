/**
 * 网关生命周期：开关打开且至少有一个有效 token 时保持 connectNative。
 */

import { loadSettings } from "../storage.js";
import { createNativeGateway } from "../native-port.js";
import { hasActiveToken } from "./auth.js";
import { TOKENS_KEY, loadAgentTokens } from "./token-store.js";
import { getAuditLog } from "./audit.js";

export const GATEWAY_ALARM = "chromegate-gw-agent-gateway";
export const GATEWAY_STATUS_KEY = "cgw.agentGatewayStatus";

export function shouldRunGateway(settings, tokens, now = Date.now()) {
  return settings?.agentGatewayEnabled === true && hasActiveToken(tokens, now);
}

let installed = null;

export function installAgentGateway(bridge) {
  if (installed) return installed;
  const gateway = createNativeGateway({
    bridge,
    inboxEnabled: async () => (await loadSettings()).agentInboxEnabled === true,
    onStatus: (status) => {
      chrome.storage.session?.set({ [GATEWAY_STATUS_KEY]: status }).catch?.(() => {});
    },
  });

  async function sync() {
    const [settings, tokens] = await Promise.all([loadSettings(), loadAgentTokens()]);
    if (shouldRunGateway(settings, tokens)) {
      gateway.start();
      const existing = await chrome.alarms.get(GATEWAY_ALARM).catch(() => null);
      if (!existing) await chrome.alarms.create(GATEWAY_ALARM, { periodInMinutes: 1 });
      gateway.setInbox(settings.agentInboxEnabled === true);
      return { running: true, inbox: settings.agentInboxEnabled === true };
    }
    gateway.stop();
    await chrome.alarms.clear(GATEWAY_ALARM).catch(() => {});
    return { running: false, inbox: false };
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== GATEWAY_ALARM) return;
    sync()
      .then(() => gateway.kick())
      .catch(() => {});
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(changes.settings || changes[TOKENS_KEY])) return;
    sync().catch(() => {});
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id) return false;
    const type = String(msg?.type || "");
    if (type === "cg.gateway.status") {
      sendResponse({ ok: true, running: gateway.isRunning(), status: gateway.status() });
      return false;
    }
    if (type === "cg.gateway.reconnect") {
      sync()
        .then((state) => sendResponse({ ok: true, ...state, status: gateway.status() }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }
    if (type === "cg.audit.list") {
      getAuditLog()
        .list({ limit: msg.limit || 50 })
        .then((entries) => sendResponse({ ok: true, entries }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }
    if (type === "cg.audit.clear") {
      getAuditLog()
        .clear()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }
    return false;
  });

  sync().catch(() => {});
  installed = { gateway, sync };
  return installed;
}
