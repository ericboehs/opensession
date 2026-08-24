import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workerSource = readFileSync(new URL("./sw.js", import.meta.url), "utf8");

type WorkerListener = (event: Record<string, unknown>) => void;

function workerHarness(scopePath = "/") {
  const origin = "https://os.test";
  const scope = new URL(scopePath, origin).href;
  const listeners = new Map<string, WorkerListener>();
  const added: string[] = [];
  const entries = new Map<string, Response>();
  const cache = {
    async add(input: string) {
      added.push(input);
      entries.set(new URL(input, scope).href, new Response(`cached:${input}`));
    },
    async match(input: string | { url: string }) {
      const raw = typeof input === "string" ? input : input.url;
      return entries.get(new URL(raw, scope).href)?.clone();
    },
    async put(input: string | { url: string }, response: Response) {
      const raw = typeof input === "string" ? input : input.url;
      entries.set(new URL(raw, scope).href, response.clone());
    },
    async keys() {
      return [...entries.keys()].map((url) => ({ url }));
    },
    async delete(input: string | { url: string }) {
      const raw = typeof input === "string" ? input : input.url;
      return entries.delete(new URL(raw, scope).href);
    },
  };
  const caches = {
    async open() {
      return cache;
    },
    async keys() {
      return [];
    },
    async delete() {
      return true;
    },
  };
  const serviceWorker = {
    registration: {
      scope,
      async getNotifications() {
        return [];
      },
      async showNotification() {},
    },
    location: { origin },
    navigator: {},
    clients: {
      async claim() {},
      async matchAll() {
        return [];
      },
      async openWindow() {},
    },
    skipWaiting() {},
    addEventListener(type: string, listener: WorkerListener) {
      listeners.set(type, listener);
    },
  };
  const networkFetch = async () => {
    throw new TypeError("offline");
  };

  new Function("self", "caches", "fetch", workerSource)(
    serviceWorker,
    caches,
    networkFetch,
  );

  return { added, listeners };
}

async function installWorker(harness: ReturnType<typeof workerHarness>) {
  const tasks: Promise<unknown>[] = [];
  harness.listeners.get("install")?.({
    waitUntil(task: Promise<unknown>) {
      tasks.push(task);
    },
  });
  await Promise.all(tasks);
}

describe("service worker gate assets", () => {
  test("precaches the icon and still backgrounds during installation", async () => {
    const harness = workerHarness();
    await installWorker(harness);

    expect(harness.added).toEqual([
      "/mac-app-icon.png",
      "/signin-bg.webp",
      "/signin-bg-dark.webp",
    ]);
  });

  test("serves the sign-in icon from cache while offline", async () => {
    const harness = workerHarness();
    await installWorker(harness);

    let response: Promise<Response> | undefined;
    const tasks: Promise<unknown>[] = [];
    harness.listeners.get("fetch")?.({
      request: {
        method: "GET",
        mode: "cors",
        url: "https://os.test/mac-app-icon.png",
      },
      respondWith(value: Promise<Response>) {
        response = value;
      },
      waitUntil(task: Promise<unknown>) {
        tasks.push(task);
      },
    });

    expect(response).toBeDefined();
    expect(await (await response!).text()).toBe("cached:/mac-app-icon.png");
    await Promise.all(tasks);
  });
});
