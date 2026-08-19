import { useState } from "react";
import { linkPrApi } from "../../lib/api";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { toast } from "../../ui/toast";
import type { LinkedPrEntry } from "../PrPanel";

/**
 * The "Link PR" affordance: a "+" chip in the tab bar (or a quiet button in
 * the actions row when there's no bar yet) that expands into a paste-a-URL
 * input. Linking accepts any PR in a registered repo.
 */
export function LinkPrControl({
  sessionId,
  variant,
  onLinked,
}: {
  sessionId: string;
  variant: "tab" | "action";
  onLinked: (all: LinkedPrEntry[], linked: LinkedPrEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const url = val.trim();
    if (!url || busy) return;
    setBusy(true);
    try {
      const res = await linkPrApi(sessionId, url);
      onLinked(res.all, res.linked);
      toast(
        `Linked ${res.linked.repo}${res.linked.number ? ` #${res.linked.number}` : ""}`,
      );
      setVal("");
      setOpen(false);
    } catch (e: any) {
      toast(e.message || "Couldn't link that PR");
    } finally {
      setBusy(false);
    }
  }

  if (!open)
    return (
      <Button
        size="sm"
        className={
          variant === "tab"
            ? "rounded-sm border-dashed bg-transparent px-2.5 py-1 text-xs text-faint shadow-none"
            : "rounded-sm bg-panel px-3 py-2 text-xs shadow-none hover:bg-hover"
        }
        onClick={() => setOpen(true)}
        title="Link another PR to this session"
      >
        {variant === "tab" ? "+" : "Link PR…"}
      </Button>
    );

  return (
    <form
      className="flex w-full max-w-[420px] items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input
        autoFocus
        size="sm"
        className="min-w-0 flex-1"
        placeholder="Paste a GitHub PR URL…"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <Button
        type="submit"
        variant="primary"
        size="sm"
        disabled={busy || !val.trim()}
      >
        {busy ? "Linking…" : "Link"}
      </Button>
    </form>
  );
}
