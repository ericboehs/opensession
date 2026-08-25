import { Button } from "../ui/button";
import { cn, mergeStylexProps } from "../ui/cn";
import { EmptyState } from "../ui/state";
import { BrandMark } from "./BrandTile";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	leading115: {
			lineHeight: "1.15"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	tracking002em: {
			letterSpacing: "-.02em"
	},
	textBalance: {
			textWrap: "balance"
	},
	minH10: {
			minHeight: "40px"
	},
	px6: {
		paddingInline: "24px",
	},
});

export function GithubConnectEmptyState({
	onConnect,
	className,
}: {
	onConnect: () => void;
	className?: string;
}) {
	return (
		<EmptyState
			title={
				<div {...stylex.props(sx.leading115, sx.fontSemibold, sx.tracking002em, sx.textBalance, typography.sectionTitle)}>
					Start your first session
				</div>
			}
			action={
				<Button
					variant="primary"
					size="lg"
					icon={<BrandMark name="github" size={18} />}
					onClick={onConnect} {...mergeStylexProps("phone:min-h-11", sx.minH10)}
				>
					Connect GitHub
				</Button>
			}
			className={cn(stylex.props(sx.px6).className, className)}
		>
			Connect a repository to get started.
		</EmptyState>
	);
}
