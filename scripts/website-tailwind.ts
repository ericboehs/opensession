import { join } from "node:path";

export async function buildWebsiteTailwind(root: string): Promise<void> {
	const proc = Bun.spawn(
		[
			join(root, "node_modules", ".bin", "tailwindcss"),
			"-i",
			join(root, "packages", "core", "opensession-server", "src", "frontend", "styles", "tailwind.css"),
			"-o",
			join(root, "packages", "clients", "website", ".demo-tailwind.css"),
			"--minify",
		],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);
	if ((await proc.exited) !== 0) {
		throw new Error(await new Response(proc.stderr).text());
	}
}
