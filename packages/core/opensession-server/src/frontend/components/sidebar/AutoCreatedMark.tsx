import { IconRobot } from "../icons";

/**
 * A row nobody started in a composer: an automation run, a report's Fix task,
 * or a session an agent minted itself. Faint ink keeps the origin visible
 * without competing with status. It rides beside the title so the status rail
 * stays aligned with every ordinary row.
 */
export function AutoCreatedMark() {
	return (
		<span
			className="ml-1 flex shrink-0 items-center text-faint"
			role="img"
			aria-label="Started by an agent, not by a person"
			title="Started by an agent, not by a person"
		>
			<IconRobot size={20} />
		</span>
	);
}
