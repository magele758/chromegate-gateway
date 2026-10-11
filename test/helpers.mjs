import { createBridge } from "../extension/lib/bridge/index.js";
import { createTokenRecord } from "../extension/lib/bridge/auth.js";
import { createAuditLog } from "../extension/lib/bridge/audit.js";
import { normalizeSettings } from "../extension/lib/storage.js";
import { createApprovalQueue, memoryAdapter } from "../extension/lib/trust/approval-queue.js";

export async function mint(name, scopes, origins = ["http://127.0.0.1:*"]) {
  return createTokenRecord({ name, scopes, origins });
}

export function makeBridge({ records, inject, observe, runJs, screenshot } = {}) {
  const tabMap = new Map([[1, { id: 1, windowId: 1, active: true, title: "App", url: "http://127.0.0.1:4173/home" }]]);
  const now = () => 1_700_000_000_000;
  const approvals = createApprovalQueue({ storage: memoryAdapter(), now });
  const auditLog = createAuditLog({ load: async () => [], save: async () => true });
  const env = {
    now,
    sleep: async () => {},
    extensionVersion: () => "0.1.0",
    getSettings: async () => normalizeSettings({ agentGatewayEnabled: true }),
    getAgentTokens: async () => records.map((item) => item.record),
    auditLog,
    approvals,
    tabs: {
      async query() {
        return [...tabMap.values()];
      },
      async get(id) {
        const tab = tabMap.get(id);
        if (!tab) throw new Error(`No tab with id ${id}`);
        return tab;
      },
      async update(id, props) {
        const tab = await this.get(id);
        if (props.url) tab.url = props.url;
        return Object.assign(tab, props);
      },
      async create(props) {
        const id = Math.max(0, ...tabMap.keys()) + 1;
        const tab = { id, windowId: 1, active: false, title: "", url: props.url, pendingUrl: props.url };
        tabMap.set(id, tab);
        return tab;
      },
      async remove(id) {
        tabMap.delete(id);
      },
    },
    inject: inject || (async () => ({ ok: true, text: "" })),
    runJs: runJs || (async () => ({ ok: true, via: "debugger", result: 1 })),
    screenshot: screenshot || (async () => ({ base64: Buffer.from("jpeg-bytes").toString("base64"), mime: "image/jpeg" })),
    observe: observe || (async () => ({ console: [], network: [], sse: [], dialogs: [] })),
  };
  return { env, bridge: createBridge(env), approvals, tabMap, auditLog };
}

export function call(bridge, record, token, tool, args, id = "1") {
  return bridge.call({ v: 1, id, tool, args }, { session: { token, sessionId: `s-${record.id}`, agentName: record.name } });
}
