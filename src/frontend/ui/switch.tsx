import * as React from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn } from "./cn";

type SwitchProps = React.ComponentProps<typeof BaseSwitch.Root> & {
	className?: string;
};

export function Switch({ className, ...props }: SwitchProps) {
	return (
		<BaseSwitch.Root
			className={cn(
				"relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer rounded-full bg-active outline-none",
				"transition-colors duration-150 data-[checked]:bg-accent",
				"focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
				"data-[disabled]:cursor-default data-[disabled]:opacity-40",
				className,
			)}
			{...props}
		>
			<BaseSwitch.Thumb className="absolute left-0.5 top-0.5 size-[18px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-transform duration-150 data-[checked]:translate-x-4" />
		</BaseSwitch.Root>
	);
}
