import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { EmptyState } from "../ui/state";
import { BrandMark, IconTile } from "./BrandTile";

export function GithubConnectEmptyState({
	onConnect,
	className,
}: {
	onConnect: () => void;
	className?: string;
}) {
	return (
		<EmptyState
			icon={<IconTile name="github" size={44} />}
			title="Connect GitHub"
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
			Choose a repository to start your first session.
		</EmptyState>
	);
}
