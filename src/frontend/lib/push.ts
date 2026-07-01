/**
 * Web Push client: registers the /backstage/sw.js service worker and manages
 * this device's push subscription. Complements lib/notify.ts (tab-bound
 * notifications) — push reaches the phone with the app closed, but only when
 * the app was opened over a secure origin (the ts.net HTTPS host).
 */

export type PushState = "unsupported" | "denied" | "off" | "on";

const SW_URL = "/backstage/sw.js";

function supported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function getPushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_URL);
    const sub = await reg?.pushManager.getSubscription();
    return sub ? "on" : "off";
  } catch {
    return "off";
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Enable push on this device for `user`. Throws with a friendly message. */
export async function enablePush(user: string): Promise<void> {
  if (!supported()) {
    throw new Error(
      window.isSecureContext
        ? "This browser doesn't support Web Push."
        : "Push needs the HTTPS origin — open Backstage via michael.taila5d766.ts.net.",
    );
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was declined.");

  const reg = await navigator.serviceWorker.register(SW_URL, { scope: "/backstage/" });
  await navigator.serviceWorker.ready;

  const keyRes = await fetch("/backstage/api/push/vapid-key");
  if (!keyRes.ok) throw new Error("Couldn't fetch the push key from the server.");
  const { publicKey } = await keyRes.json();

  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));

  const res = await fetch("/backstage/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, subscription: sub.toJSON() }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to register the subscription.");
  }
}

/** Disable push on this device (unsubscribes + tells the server). */
export async function disablePush(): Promise<void> {
  if (!supported()) return;
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await fetch("/backstage/api/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  }).catch(() => {});
}
