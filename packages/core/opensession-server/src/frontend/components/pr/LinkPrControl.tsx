import { useState } from "react";
import { IconLink } from "../icons";
import { linkPrApi } from "../../lib/api";
import { Button } from "../../ui/button";
import { Field, Input } from "../../ui/input";
import { Popover } from "../../ui/popover";
import { toast } from "../../ui/toast";
import type { LinkedPrEntry } from "../PrPanel";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";
import { mergeStylexProps } from "../../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	p4: {
			padding: "16px"
	},
	flex: {
			display: "flex"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap4: {
			gap: "16px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	mt1: {
			marginTop: "4px"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	justifyEnd: {
			justifyContent: "flex-end"
	},
	gap25: {
			gap: "10px"
	},
});

/**
 * Opens the link flow in an anchored modal instead of replacing the action row.
 * Linking accepts any PR in a registered repo.
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
    await (async () => {
const res = await linkPrApi(sessionId, url);
      onLinked(res.all, res.linked);
      toast(
        `Linked ${res.linked.repo}${res.linked.number ? ` #${res.linked.number}` : ""}`,
      );
      setVal("");
      setOpen(false);
})().catch(async (e: any) => {
toast(e.message || "Couldn't link that PR");
}).finally(async () => {
setBusy(false);
});
  }

  const tab = variant === "tab";

  return (
    <Popover.Root
      open={open}
      onOpenChange={setOpen}
      modal="trap-focus"
      exclusive={false}
    >
      <Popover.Trigger
        render={
          <Button
            variant={tab ? "ghost" : "soft"}
            size="sm"
            className={
              tab
                ? "px-2.5 text-xs text-faint phone:min-h-11"
                : "phone:min-h-11"
            }
            icon={tab ? undefined : <IconLink size={20} />}
            title="Link another PR to this session"
          >
            {tab ? "+" : "Link PR…"}
          </Button>
        }
      />
      <Popover.Popup
        side="bottom"
        align="start"
        initialFocus {...mergeStylexProps("w-[min(380px,calc(100vw-16px))]", sx.p4)}
      >
        <form
          {...stylex.props(sx.flex, sx.flexCol, sx.gap4)}
          aria-label="Link pull request"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div>
            <div {...stylex.props(sx.fontSemibold, sx.textFg, typography.label)}>
              Link pull request
            </div>
            <div {...stylex.props(sx.mt1, sx.textDim, typography.meta)}>
              Paste a GitHub pull request URL.
            </div>
          </div>
          <Field label="Pull request URL">
            <Input
              autoFocus
              className="phone:min-h-11 phone:text-input-phone"
              placeholder="https://github.com/org/repo/pull/123"
              value={val}
              onChange={(event) => setVal(event.target.value)}
            />
          </Field>
          <div {...stylex.props(sx.flex, sx.justifyEnd, sx.gap25)}>
            <Popover.Close
              render={
                <Button
                  variant="soft"
                  className="phone:min-h-11"
                  disabled={busy}
                >
                  Cancel
                </Button>
              }
            />
            <Button
              type="submit"
              variant="primary"
              className="phone:min-h-11"
              disabled={busy || !val.trim()}
            >
              {busy ? "Linking…" : "Link PR"}
            </Button>
          </div>
        </form>
      </Popover.Popup>
    </Popover.Root>
  );
}
