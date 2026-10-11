import { installBridge } from "./lib/bridge/index.js";
import { installAgentGateway } from "./lib/bridge/gateway.js";
import { scopesForNewToken, normalizeTokenOrigins } from "./lib/bridge/auth.js";
import { addAgentToken, listAgentTokens, revokeAgentToken } from "./lib/bridge/token-store.js";
import { loadSettings, saveSettings } from "./lib/storage.js";

const bridge = installBridge();
installAgentGateway(bridge);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender?.id !== chrome.runtime.id) return false;
  const type = String(msg?.type || "");
  if (type === "cg.settings.get") {
    loadSettings().then((settings) => sendResponse({ ok: true, settings })).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (type === "cg.settings.set") {
    saveSettings(msg.settings || {})
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (type === "cg.tokens.list") {
    listAgentTokens().then((tokens) => sendResponse({ ok: true, tokens })).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (type === "cg.tokens.create") {
    const origins = normalizeTokenOrigins(msg.origins);
    if (!origins.length) {
      sendResponse({ ok: false, error: "至少填写一个 origin。" });
      return false;
    }
    addAgentToken({
      name: msg.name,
      scopes: scopesForNewToken(msg.scopes),
      origins,
      expiresAt: Number.isFinite(Number(msg.expiresAt)) ? Number(msg.expiresAt) : null,
    })
      .then((created) => sendResponse({ ok: true, token: created.token, info: created.info }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (type === "cg.tokens.revoke") {
    revokeAgentToken(String(msg.id || ""))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (type === "cg.approvals.list") {
    bridge.approvals
      .list({ status: "pending" })
      .then((entries) => sendResponse({ ok: true, entries }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (type === "cg.approvals.resolve") {
    bridge.approvals
      .resolve(String(msg.id || ""), msg.allow === true)
      .then((entry) => sendResponse({ ok: true, entry }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});
