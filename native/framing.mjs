export function encodeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function tryReadMessage(buf) {
  if (buf.length < 4) return null;
  const len = buf.readUInt32LE(0);
  if (len < 0 || len > 8 * 1024 * 1024) throw new Error(`native message too large: ${len}`);
  if (buf.length < 4 + len) return null;
  const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
  return { msg, rest: buf.subarray(4 + len) };
}
