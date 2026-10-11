import { normalizeBridgeSettings } from "./bridge/policy.js";
import { defaultIrreversibleActions, normalizeIrreversibleActions } from "./trust/irreversible.js";

export function defaultSettings() {
  return {
    agentGatewayEnabled: false,
    agentInboxEnabled: false,
    irreversibleActions: defaultIrreversibleActions(),
    ...normalizeBridgeSettings({ agentBridgeEnabled: false, agentBridgeOrigins: [] }),
  };
}

export function normalizeSettings(raw) {
  const bridge = normalizeBridgeSettings(raw);
  return {
    agentBridgeEnabled: false,
    agentBridgeOrigins: bridge.agentBridgeOrigins,
    agentGatewayEnabled: raw?.agentGatewayEnabled === true,
    agentInboxEnabled: raw?.agentInboxEnabled === true,
    irreversibleActions: normalizeIrreversibleActions(raw?.irreversibleActions),
  };
}

function areaOf(storage) {
  return storage || globalThis.chrome?.storage?.local;
}

export async function loadSettings(storage) {
  const area = areaOf(storage);
  if (!area?.get) return defaultSettings();
  const got = await area.get("settings");
  return normalizeSettings(got?.settings);
}

export async function saveSettings(next, storage) {
  const area = areaOf(storage);
  const settings = normalizeSettings({ ...(await loadSettings(storage)), ...(next || {}) });
  await area.set({ settings });
  return settings;
}
