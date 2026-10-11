export const NATIVE_HOST_NAME = "com.chromegate.gateway";

export function installHint() {
  return "Native Host 需要你本人登记。见 README 的安装一节，ChromeGate Gateway 不会自行写入系统目录。";
}

export function describeNativeError(err) {
  const msg = err?.message || String(err || "");
  if (/Specified native messaging host not found|host not found|Access to the specified native messaging host is forbidden/i.test(msg)) {
    return `未安装 Native Host，或 allowed_origins 对不上当前扩展 ID。${installHint()}`;
  }
  if (/Native host has exited|disconnected/i.test(msg)) return `Native Host 意外退出。${msg}`;
  return msg || "Native Host 调用失败。";
}
