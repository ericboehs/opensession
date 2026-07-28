// Usage: bun shot.mjs <path> <outfile> [width] [height]
const path = process.argv[2] || "/backstage/";
const out = process.argv[3] || "shot.png";
const width = parseInt(process.argv[4] || "390", 10);
const height = parseInt(process.argv[5] || "844", 10);

const chrome = Bun.spawn(
  [
    "/usr/bin/google-chrome",
    "--headless=new",
    "--remote-debugging-port=9223",
    "--user-data-dir=/tmp/shot-chrome",
    "--no-first-run",
    "--no-sandbox",
    `--window-size=${width},${height}`,
  ],
  { stdout: "ignore", stderr: "ignore" },
);

await new Promise((r) => setTimeout(r, 1500));

async function cdp() {
  const res = await fetch("http://127.0.0.1:9223/json");
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page");
  return page.webSocketDebuggerUrl;
}

const wsUrl = await cdp();
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});
function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
await new Promise((r) => (ws.onopen = r));

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 2,
  mobile: true,
});
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `localStorage.setItem('opensession-user',${JSON.stringify(process.env.OPENSESSION_SCREENSHOT_USER || "Local User")});`,
});
await send("Page.navigate", { url: `http://127.0.0.1:3850${path}` });
await new Promise((r) => setTimeout(r, 9000));
const { data } = await send("Page.captureScreenshot", { format: "png" });
await Bun.write(out, Buffer.from(data, "base64"));
ws.close();
chrome.kill();
console.log("wrote", out);
process.exit(0);
