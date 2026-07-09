// Build shareable OpenSession links and copy them to the clipboard. The app is
// served over plain HTTP on the Tailscale IP, so `navigator.clipboard` is often
// absent (it needs a secure context) — every copy path falls back to a hidden
// textarea + execCommand, the same trick the viewer's share button uses.

import { BASE_PATH } from "./base";

/** Canonical chat/workspace URL path — workspace-scoped when the chat has one. */
export function chatPath(session: {
  id: string;
  projectId?: string | null;
}): string {
  return session.projectId
    ? `${BASE_PATH}/workspace/${encodeURIComponent(session.projectId)}/chat/${encodeURIComponent(session.id)}`
    : `${BASE_PATH}/session/${encodeURIComponent(session.id)}`;
}

/** Session-less PR preview URL path. */
export function prPath(repo: string, branch: string): string {
  return `${BASE_PATH}/pr/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}`;
}

/** Absolute link for a path built above. */
export function absoluteLink(path: string): string {
  return `${location.origin}${path}`;
}

/** Copy text to the clipboard, secure-context or not; `onDone` fires either way. */
export function copyToClipboard(text: string, onDone?: () => void): void {
  const done = onDone || (() => {});
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text: string, onDone: () => void): void {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {
    // Best-effort — a failed copy shouldn't throw into the caller.
  }
  onDone();
}
