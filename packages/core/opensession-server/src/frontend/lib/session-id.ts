/** Mint the native session id before sending a create request.
 *
 * Knowing the id on both sides makes session creation idempotent: if the
 * WebSocket drops before its acknowledgement arrives, the client can replay
 * the same request without creating a second session.
 */
export function newClientSessionId(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Math.max(0, Math.min(now, 0xffffffffffff));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  // UUIDv7 version and RFC 9562 variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  const uuid = [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
  return `os-${uuid}`;
}
