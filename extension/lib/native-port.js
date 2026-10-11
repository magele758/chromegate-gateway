import { NATIVE_HOST_NAME, describeNativeError } from "./native-host.js";
import { errorResponse } from "./bridge/protocol.js";

export const GATEWAY_PROTOCOL = 2;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 60_000;

export function reconnectDelay(attempt, base = RECONNECT_BASE_MS, max = RECONNECT_MAX_MS) {
  return Math.min(max, base * 2 ** Math.max(0, attempt));
}

export function createNativeGateway({
  bridge,
  connect = (name) => chrome.runtime.connectNative(name),
  lastError = () => globalThis.chrome?.runtime?.lastError?.message || "",
  onStatus = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
  now = () => Date.now(),
  extensionVersion = () => globalThis.chrome?.runtime?.getManifest?.().version ?? null,
  extensionId = () => globalThis.chrome?.runtime?.id ?? "",
  hostName = NATIVE_HOST_NAME,
  inboxEnabled = async () => false,
} = {}) {
  let port = null;
  let timer = null;
  let attempt = 0;
  let running = false;
  let status = { state: "stopped", at: now() };

  function setStatus(next) {
    status = { ...next, at: now() };
    try {
      onStatus(status);
    } catch {
      /* status sink must not break the port */
    }
  }

  function schedule(reason) {
    if (!running || timer) return;
    const delay = reconnectDelay(attempt);
    attempt += 1;
    setStatus({ state: "retrying", error: reason || null, retryInMs: delay, attempt });
    timer = setTimer(() => {
      timer = null;
      open();
    }, delay);
  }

  function pushEvent(sessionId, event) {
    if (!port || status.state !== "connected") return;
    try {
      port.postMessage({ type: "bridge.event", sessionId, event });
    } catch {
      /* port closing */
    }
  }
  bridge?.events?.setSink?.(pushEvent);

  function sessionsGone() {
    try {
      bridge?.closeAllSessions?.();
    } catch {
      /* bridge without session state */
    }
  }

  function drop(current) {
    if (port !== current) return;
    port = null;
    sessionsGone();
    try {
      current.disconnect();
    } catch {
      /* already gone */
    }
  }

  async function dispatch(current, msg) {
    let response;
    try {
      response = await bridge.call(msg.request, {
        session: { token: msg.token, sessionId: msg.sessionId, agentName: msg.agentName },
      });
    } catch (err) {
      response = errorResponse(msg.request?.id, err);
    }
    if (port !== current) return;
    try {
      current.postMessage({ type: "bridge.result", sessionId: msg.sessionId ?? null, callId: msg.callId ?? null, response });
    } catch {
      /* port closed while the call ran */
    }
  }

  function handle(current, msg) {
    if (port !== current || !msg || typeof msg !== "object") return;
    if (msg.type === "broker.ready") {
      attempt = 0;
      setStatus({ state: "connected", socketPath: msg.socketPath || null, hostVersion: msg.version || null });
      return;
    }
    if (msg.type === "broker.error") {
      drop(current);
      schedule(String(msg.error || "broker 启动失败"));
      return;
    }
    if (msg.type === "bridge.call") {
      dispatch(current, msg);
      return;
    }
    if (msg.type === "bridge.session.closed") {
      bridge?.closeSession?.(String(msg.sessionId || ""));
    }
  }

  async function postStart(current) {
    let inbox = false;
    try {
      inbox = (await inboxEnabled()) === true;
    } catch {
      inbox = false;
    }
    if (port !== current) return;
    current.postMessage({ type: "broker.start", protocol: GATEWAY_PROTOCOL, extensionVersion: extensionVersion(), inbox });
  }

  function open() {
    if (!running || port) return;
    let current;
    try {
      current = connect(hostName);
    } catch (err) {
      schedule(describeNativeError(err, extensionId()));
      return;
    }
    port = current;
    setStatus({ state: "connecting" });
    current.onMessage.addListener((msg) => handle(current, msg));
    current.onDisconnect.addListener(() => {
      const reason = lastError();
      if (port !== current) return;
      port = null;
      sessionsGone();
      schedule(reason ? describeNativeError(new Error(reason), extensionId()) : "Native Host 已断开");
    });
    postStart(current).catch((err) => {
      drop(current);
      schedule(err?.message || String(err));
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      open();
    },
    stop() {
      running = false;
      if (timer) clearTimer(timer);
      timer = null;
      if (port) drop(port);
      setStatus({ state: "stopped" });
    },
    kick() {
      if (!running || port) return;
      if (timer) clearTimer(timer);
      timer = null;
      open();
    },
    setInbox(enabled) {
      if (!port || status.state !== "connected") return;
      try {
        port.postMessage({ type: "inbox.set", enabled: enabled === true });
      } catch {
        /* port closing */
      }
    },
    isRunning: () => running,
    isConnected: () => Boolean(port) && status.state === "connected",
    status: () => status,
  };
}
