// Most-recently-opened session ids, newest first. Updated whenever a session
// is opened in the viewer (App.tsx) and read by the sidebar's "Recently opened"
// section. A few extra are kept beyond what's shown so the list survives a
// handful of archived/deleted sessions.
const KEY = "opensession-recents";
const CHANGE_EVENT = "opensession-recents-changed";
const CAP = 20;

function read(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function getRecents(): string[] {
  return read();
}

export function pushRecent(id: string): void {
  const next = [id, ...read().filter((x) => x !== id)].slice(0, CAP);
  localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onRecentsChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}
