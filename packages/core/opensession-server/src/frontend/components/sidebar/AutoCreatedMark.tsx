import { IconRobot } from "../icons";

/**
 * A row nobody started by hand: an agent minted this session or workspace
 * through the automation machine identity.
 *
 * Not an automation. An automation is a job somebody configured, with a name,
 * a trigger and an owner, and its runs file under that name in the Automations
 * band. These are one-off workspaces an agent opened for itself with no
 * automation behind them, which is why they sit in the ordinary lanes and need
 * a mark at all.
 *
 * The separated section answers how much of the list is automatic. This
 * answers whether THIS one is, which is the question a row still raises once
 * the grouping moves it in next to work a person started (a repo band puts
 * both in one column). Faint ink, always on: the fact is worth keeping on the
 * page. It rides beside the title rather than in the rail, so the status mark
 * every other row wears keeps its slot and no title leaves the rail.
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
