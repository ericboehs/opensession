// Desktop screenshot of a session's PR strip. Usage: bun shot-pr.mjs <sessionId> <out.png>
const id = process.argv[2];
const out = process.argv[3] || "pr.png";
const width = 1500, height = 950;

const chrome = Bun.spawn(
  ["/usr/bin/google-chrome", "--headless=new", "--remote-debugging-port=9224",
   "--user-data-dir=/tmp/shot-pr-chrome", "--no-first-run", "--no-sandbox",
   `--window-size=${width},${height}`],
  { stdout: "ignore", stderr: "ignore" },
);
await new Promise((r) => setTimeout(r, 1500));
const res = await fetch("http://127.0.0.1:9224/json");
const page = (await res.json()).find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0; const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
function send(method, params = {}) {
  return new Promise((r) => { const i = ++mid; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
}
await new Promise((r) => (ws.onopen = r));
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem('backstage-user','Michiel');` });
await send("Page.navigate", { url: `http://127.0.0.1:3850/backstage/session/${id}` });
await new Promise((r) => setTimeout(r, 9000));
// Open the workspace panel (click the panel toggle) if not already open.
await send("Runtime.evaluate", { expression: `
  (() => {
    const b = document.querySelector('.btn-panel-toggle, .btn-workspace');
    if (b && !document.querySelector('.pr-bar')) b.click();
  })();
` });
await new Promise((r) => setTimeout(r, 2500));
// Report measured heights of the chip vs the merge button.
const measure = await send("Runtime.evaluate", {
  expression: `JSON.stringify((() => {
    const bar = document.querySelector('.pr-bar');
    const chip = document.querySelector('.pr-bar .pr-num-chip');
    const btn = document.querySelector('.pr-bar .pr-bar-btn');
    const r = (el) => el ? { h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) } : null;
    return { hasBar: !!bar, chip: r(chip), btn: r(btn), state: document.querySelector('.pr-bar .pr-bar-state')?.textContent };
  })())`, returnByValue: true });
console.log("MEASURE:", measure.result.value);
const shot = await send("Page.captureScreenshot", { format: "png" });
await Bun.write(out, Buffer.from(shot.data, "base64"));
console.log("wrote", out);
chrome.kill();
process.exit(0);
