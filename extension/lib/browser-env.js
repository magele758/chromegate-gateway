import { restrictedUrl } from "./urls.js";
import { runJsRestricted } from "./run-js.js";
import { createObserver } from "./observe.js";
import { loadSettings } from "./storage.js";
import { loadAgentTokens } from "./bridge/token-store.js";
import { getAuditLog } from "./bridge/audit.js";
import { chromeSessionStorage } from "./bridge/jobs.js";
import { chromeStorageAdapter, createApprovalQueue } from "./trust/approval-queue.js";

export async function injectFunction(tabId, func, args = []) {
  const tab = await globalThis.chrome.tabs.get(tabId);
  if (restrictedUrl(tab?.url)) throw new Error(`受限页：${tab?.url || ""}`);
  const [entry] = await globalThis.chrome.scripting.executeScript({ target: { tabId }, func, args });
  return entry?.result;
}

export function createDefaultEnv() {
  const observer = createObserver();
  return {
    getSettings: () => loadSettings(),
    tabs: {
      get: (id) => globalThis.chrome.tabs.get(id),
      query: (query) => globalThis.chrome.tabs.query(query),
      create: (props) => globalThis.chrome.tabs.create(props),
      update: (id, props) => globalThis.chrome.tabs.update(id, props),
      remove: (id) => globalThis.chrome.tabs.remove(id),
    },
    getAgentTokens: () => loadAgentTokens(),
    auditLog: getAuditLog(),
    approvals: createApprovalQueue({ storage: chromeStorageAdapter() }),
    sessionStorage: chromeSessionStorage(),
    inject: injectFunction,
    runJs: (tabId, code) =>
      runJsRestricted(tabId, code, {
        debuggerSend: async (id, method, params) => {
          await observer.ensure(id);
          return globalThis.chrome.debugger.sendCommand({ tabId: id }, method, params);
        },
        userScriptsExecute:
          typeof globalThis.chrome?.userScripts?.execute === "function"
            ? (opts) => globalThis.chrome.userScripts.execute(opts)
            : undefined,
      }),
    screenshot: async (tabId, { fullPage = false, clip = null } = {}) => {
      await observer.ensure(tabId);
      const params = { format: "jpeg", quality: 60, captureBeyondViewport: Boolean(fullPage) };
      if (clip && clip.width > 0 && clip.height > 0) {
        params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
      }
      const shot = await globalThis.chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", params);
      return { base64: shot?.data || "", mime: "image/jpeg" };
    },
    observe: async (tabId) => {
      await observer.ensure(tabId);
      return observer.read(tabId);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    extensionVersion: () => globalThis.chrome.runtime.getManifest().version,
  };
}
