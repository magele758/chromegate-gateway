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

export const SETTINGS_KEY = "cgw.settings";

function areaOf(storage) {
  return storage || globalThis.chrome?.storage?.local;
}

export async function loadSettings(storage) {
  const area = areaOf(storage);
  if (!area?.get) return defaultSettings();
  const got = await area.get(SETTINGS_KEY);
  return normalizeSettings(got?.[SETTINGS_KEY]);
}

export async function saveSettings(next, storage) {
  const area = areaOf(storage);
  const settings = normalizeSettings({ ...(await loadSettings(storage)), ...(next || {}) });
  await area.set({ [SETTINGS_KEY]: settings });
  return settings;
}
