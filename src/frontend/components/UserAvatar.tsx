import React, { useEffect, useState } from "react";
import { cn } from "../ui/cn";

/**
 * GitHub logins for the team (mirrors TEAM_GIT_IDENTITY in
 * src/server/shared/user-mappings.ts). Keyed by lowercased first name — the
 * shape of web user-picker names, presence viewers and `startedBy`, and also
 * the first token of full names coming from Slack ("Kent de Bruin" → "kent").
 */
const GITHUB_LOGIN: Record<string, string> = {
	michiel: "happylinks",
	jaap: "jfrolich",
	kent: "kentdebruin",
	grant: "9ranty",
	johnny: "johnnylinsf",
	john: "soutar",
	louise: "louisedesadeleer",
	thibault: "thiblahute",
};

export function githubLoginFor(name?: string | null): string | null {
	if (!name) return null;
	const first = name.trim().split(/\s+/)[0]?.toLowerCase();
	return (first && GITHUB_LOGIN[first]) || null;
}

/**
 * Round user picture: the person's GitHub avatar, falling back to their
 * initial for unknown users (Michael, Anonymous) or when the image fails to
 * load. `children` render on top of the circle — the presence facepile uses
 * that for its count badge.
 */
export function UserAvatar({
	name,
	size = 24,
	className,
	title,
	style,
	children,
}: {
	name: string;
	size?: number;
	className?: string;
	title?: string;
	style?: React.CSSProperties;
	children?: React.ReactNode;
}) {
	const login = githubLoginFor(name);
	const [failed, setFailed] = useState(false);
	useEffect(() => setFailed(false), [login]);
	return (
		<span
			className={cn("user-avatar", className)}
			style={{
				width: size,
				height: size,
				fontSize: Math.max(9, Math.round(size * 0.46)),
				...style,
			}}
			title={title}
		>
			{login && !failed ? (
				<img
					src={`https://github.com/${login}.png?size=${size * 2}`}
					alt={name}
					loading="lazy"
					draggable={false}
					onError={() => setFailed(true)}
				/>
			) : (
				name.charAt(0).toUpperCase()
			)}
			{children}
		</span>
	);
}
