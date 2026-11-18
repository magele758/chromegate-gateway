import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mapPath = resolve(root, "docs/feature-map.md");
const text = readFileSync(mapPath, "utf8");

assert.match(text, /\| 用户入口 \| 用户可观察的行为 \| 从哪里改 \| 从哪里验证 \|/);

const links = [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]);
const relativeLinks = links.filter((href) => !/^[a-z]+:/i.test(href) && !href.startsWith("#"));
assert.ok(relativeLinks.length > 0, "feature map has no relative links");

const missing = [];
for (const href of relativeLinks) {
  const [pathPart] = href.split("#");
  const target = resolve(dirname(mapPath), pathPart);
  const inside = relative(root, target);
  if (inside.startsWith("..") || !existsSync(target) || !statSync(target).isFile()) {
    missing.push(`${href} -> ${target}`);
  }
}
assert.deepEqual(missing, []);
console.log(`feature map ok (${relativeLinks.length} links)`);
