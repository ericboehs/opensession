import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { EmptyState } from "../ui/state";
import { BrandMark } from "./BrandTile";

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
				<div className="text-section-title leading-[1.15] font-semibold tracking-[-0.02em] text-balance">
					Start your first session
				</div>
			}
			action={
				<Button
					variant="primary"
					size="lg"
					icon={<BrandMark name="github" size={18} />}
					onClick={onConnect}
					className="min-h-10 phone:min-h-11"
				>
					Connect GitHub
				</Button>
			}
			className={cn("px-6", className)}
		>
			Connect a repository to get started.
		</EmptyState>
	);
}
