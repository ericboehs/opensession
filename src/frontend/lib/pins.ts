const KEY = "michael-pins";
const CHANGE_EVENT = "michael-pins-changed";

function read(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function getPins(): string[] {
  return read();
}

export function isPinned(id: string): boolean {
  return read().includes(id);
}

export function togglePin(id: string): string[] {
  const pins = read();
  const next = pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id];
  localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return next;
}

export function onPinsChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}
