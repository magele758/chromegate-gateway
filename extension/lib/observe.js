/** 调试器上的控制台、网络和对话框缓冲。只记录，不解释页面内容。 */

function seqOf(data, eventId) {
  try {
    const parsed = JSON.parse(String(data || ""));
    const value = Number(parsed?.seq ?? parsed?.n);
    if (Number.isInteger(value)) return value;
  } catch {
    /* 不是 JSON */
  }
  const fromId = Number(eventId);
  return Number.isInteger(fromId) ? fromId : null;
}

function textOf(args) {
  return (Array.isArray(args) ? args : [])
    .map((arg) => arg?.value ?? arg?.description ?? "")
    .join(" ")
    .slice(0, 500);
}

export function createObserver(api = globalThis.chrome) {
  const buffers = new Map();
  const requests = new Map();
  const attached = new Set();

  function buf(tabId) {
    if (!buffers.has(tabId)) buffers.set(tabId, { console: [], network: [], sse: [], dialogs: [] });
    return buffers.get(tabId);
  }

  api?.debugger?.onEvent?.addListener?.((source, method, params) => {
    const tabId = source?.tabId;
    if (tabId == null) return;
    const bucket = buf(tabId);
    if (method === "Runtime.consoleAPICalled") {
      bucket.console.push({ level: params?.type || "log", text: textOf(params?.args), ts: Date.now() });
    } else if (method === "Runtime.exceptionThrown") {
      bucket.console.push({
        level: "error",
        text: String(params?.exceptionDetails?.text || params?.exceptionDetails?.exception?.description || "exception").slice(0, 500),
        ts: Date.now(),
      });
    } else if (method === "Network.requestWillBeSent") {
      const url = params?.request?.url || "";
      requests.set(params.requestId, url);
      bucket.network.push({
        requestId: params.requestId,
        url,
        method: params?.request?.method || "GET",
        status: null,
      });
    } else if (method === "Network.responseReceived") {
      const item = bucket.network.find((entry) => entry.requestId === params.requestId);
      if (item) {
        item.status = params?.response?.status ?? null;
        item.mime = params?.response?.mimeType || "";
      }
    } else if (method === "Network.eventSourceMessageReceived") {
      bucket.sse.push({
        requestId: params.requestId,
        url: requests.get(params.requestId) || "",
        eventName: params.eventName || "",
        data: String(params.data || "").slice(0, 2000),
        eventId: params.eventId || "",
        seq: seqOf(params.data, params.eventId),
      });
    } else if (method === "Page.javascriptDialogOpening") {
      bucket.dialogs.push({
        type: params?.type || "alert",
        message: String(params?.message || "").slice(0, 500),
        url: params?.url || "",
      });
    }
  });

  return {
    async ensure(tabId) {
      if (!api?.debugger?.attach || !api?.debugger?.sendCommand) {
        throw new Error("当前环境没有 chrome.debugger。");
      }
      if (!attached.has(tabId)) {
        await api.debugger.attach({ tabId }, "1.3");
        attached.add(tabId);
        await api.debugger.sendCommand({ tabId }, "Network.enable", {});
        await api.debugger.sendCommand({ tabId }, "Runtime.enable", {});
        await api.debugger.sendCommand({ tabId }, "Page.enable", {});
      }
      return buf(tabId);
    },
    read(tabId) {
      const bucket = buf(tabId);
      return {
        console: bucket.console.slice(),
        network: bucket.network.slice(),
        sse: bucket.sse.slice(),
        dialogs: bucket.dialogs.slice(),
      };
    },
    markAttached(tabId) {
      attached.add(tabId);
    },
  };
}
