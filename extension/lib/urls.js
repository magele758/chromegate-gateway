/** 扩展不能操作的浏览器内部页面。 */
export function restrictedUrl(url) {
  const value = String(url || "");
  if (!value) return true;
  if (/^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-untrusted):/i.test(value)) return true;
  if (value.startsWith("https://chrome.google.com/webstore")) return true;
  if (value.startsWith("https://chromewebstore.google.com")) return true;
  return false;
}
