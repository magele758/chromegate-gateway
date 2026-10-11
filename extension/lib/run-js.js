/**
 * run_js 只走两条路：chrome.debugger 的 Runtime.evaluate，或 chrome.userScripts.execute。
 * 扩展进程里不使用动态函数构造。
 */

const MAX_CODE = 8000;

function expressionFor(source) {
  const body = /^\s*return\b/.test(source) || /[;{}]/.test(source) ? source : `return (${source})`;
  return `(async () => { ${body} })()`;
}

function isCsp(text) {
  return /Content Security Policy|unsafe-eval|EvalError/i.test(String(text || ""));
}

function exceptionText(details) {
  if (!details) return "";
  return details.text || details.exception?.description || details.exception?.value || "页面脚本异常";
}

export function userScriptWrapper(source) {
  const body = /^\s*return\b/.test(source) || /[;{}]/.test(source) ? source : `return (${source})`;
  return `(async () => {
    try {
      const value = await (async () => { ${body} })();
      let result = value;
      try { result = JSON.parse(JSON.stringify(value)); } catch { result = String(value); }
      return { ok: true, via: "userScripts", result };
    } catch (err) {
      return { ok: false, via: "userScripts", error: String((err && err.message) || err) };
    }
  })()`;
}

export async function runJsRestricted(tabId, code, { debuggerSend, userScriptsExecute } = {}) {
  const source = String(code ?? "");
  if (!source.trim()) return { ok: false, error: "空代码" };
  if (source.length > MAX_CODE) return { ok: false, error: "代码过长" };

  if (typeof debuggerSend === "function") {
    try {
      const res = await debuggerSend(tabId, "Runtime.evaluate", {
        expression: expressionFor(source),
        awaitPromise: true,
        returnByValue: true,
      });
      const failed = exceptionText(res?.exceptionDetails);
      if (!failed) return { ok: true, via: "debugger", result: res?.result?.value ?? null };
      if (!isCsp(failed) || typeof userScriptsExecute !== "function") return { ok: false, via: "debugger", error: failed };
    } catch (err) {
      if (!isCsp(err?.message) || typeof userScriptsExecute !== "function") throw err;
    }
  }

  if (typeof userScriptsExecute === "function") {
    const [entry] = await userScriptsExecute({
      target: { tabId },
      world: "USER_SCRIPT",
      js: [{ code: userScriptWrapper(source) }],
    });
    if (entry?.error) return { ok: false, via: "userScripts", error: String(entry.error) };
    return entry?.result ?? { ok: false, via: "userScripts", error: "无结果" };
  }

  return { ok: false, error: "run_js 只允许 chrome.debugger Runtime.evaluate 或 chrome.userScripts.execute。" };
}
