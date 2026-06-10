const KEY = "michael-pins";

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
  return next;
}
