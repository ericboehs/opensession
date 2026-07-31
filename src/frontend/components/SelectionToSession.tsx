import React, { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentUser } from "./UserPicker";
import { Button } from "../ui/button";

interface Props {
  sessionId: string;
  /** Human label for the source, e.g. `PR #1234` — used in the delivered message. */
  label: string;
  /** WS sender; when absent the selection popover is disabled (read-only view). */
  send?: (msg: any) => void;
  children: React.ReactNode;
}

interface Selection {
  text: string;
  x: number;
  y: number;
}

/**
 * Wraps a region of selectable text. When the user selects text inside it, a
 * floating "Send to session" popover appears; they can attach a message and send
 * the quoted selection + message to `sessionId` as a `prompt` (the server starts a
 * turn if idle, or steers/queues if the session is busy — same path as the diff
 * comment feature). Renders as `display:contents` so it doesn't disturb layout.
 */
export function SelectionToSession({ sessionId, label, send, children }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);

  const dismiss = useCallback(() => {
    setSel(null);
    setComposing(false);
    setMessage("");
    setSent(false);
  }, []);

  const onMouseUp = useCallback(() => {
    if (!send) return;
    // Defer so the browser has finalised the selection after mouseup.
    setTimeout(() => {
      const s = window.getSelection();
      const text = s?.toString().trim() || "";
      if (!s || s.rangeCount === 0 || text.length < 2) return;
      const anchor = s.anchorNode;
      // Only act on selections inside our region (ignore the popover's own text).
      if (!anchor || !hostRef.current || !hostRef.current.contains(anchor)) return;
      if (popRef.current && anchor && popRef.current.contains(anchor)) return;
      const rect = s.getRangeAt(0).getBoundingClientRect();
      setSel({ text, x: rect.left + rect.width / 2, y: rect.bottom });
      setComposing(false);
      setMessage("");
      setSent(false);
    }, 0);
  }, [send]);

  // Dismiss on outside click / Escape.
  useEffect(() => {
    if (!sel) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && popRef.current.contains(e.target as Node)) return;
      dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [sel, dismiss]);

  const doSend = useCallback(() => {
    if (!send || !sel) return;
    const user = getCurrentUser();
    const quoted = sel.text
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const note = message.trim();
    const content =
      `${user} selected this text in ${label} and wants you to act on it:\n\n` +
      `${quoted}\n\n` +
      (note ? note : "(no extra message — use the selection as the instruction / context)");
    send({ type: "prompt", sessionId, user, content });
    setSent(true);
    setTimeout(dismiss, 1400);
  }, [send, sel, message, label, sessionId, dismiss]);

  return (
    <div ref={hostRef} className="selection-host" onMouseUp={onMouseUp}>
      {children}
      {sel && send && (
        <div
          ref={popRef}
          className="selection-popover"
          style={{ left: sel.x, top: sel.y + 6 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {sent ? (
            <div className="selection-sent">Sent to session ✓</div>
          ) : composing ? (
            <div className="selection-compose">
              <div className="selection-quote">{sel.text}</div>
              <textarea
                autoFocus
                className="selection-input"
                rows={2}
                placeholder="Message to the session (optional)… ⌘↵ to send"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    doSend();
                  }
                }}
              />
              <div className="selection-actions">
                <Button
                  variant="default"
                  size="sm"
                  className="min-h-0 border-line-strong bg-transparent px-3 py-[5px] text-[13px] font-normal shadow-none"
                  onClick={dismiss}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  className="min-h-0 px-[14px] py-[6px] text-supporting font-medium shadow-none"
                  onClick={doSend}
                >
                  Send to session
                </Button>
              </div>
            </div>
          ) : (
            <button className="selection-trigger" onClick={() => setComposing(true)}>
              💬 Send to session
            </button>
          )}
        </div>
      )}
    </div>
  );
}
