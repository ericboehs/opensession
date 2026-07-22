/**
 * One-command OS¹ desktop development:
 *   1. serve this worktree's frontend against the production API
 *   2. wait until that proxy is accepting requests
 *   3. launch the vendored Electron shell against it
 *
 * Ctrl+C (or either child exiting) shuts down both processes.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAC_APP_ROOT = join(ROOT, "os1-mac");
const MAC_APP_EXECUTABLE = join(
	MAC_APP_ROOT,
	"dist/mac-arm64/OS¹.app/Contents/MacOS/OS¹",
);
const PORT = Number(process.env.PORT || 3851);
const APP_URL = `http://127.0.0.1:${PORT}`;
const children: Bun.Subprocess[] = [];
let interrupted = false;

function spawn(command: string[], cwd: string, env = process.env) {
	const child = Bun.spawn(command, {
		cwd,
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	children.push(child);
	return child;
}

function stopChildren() {
	for (const child of children) {
		if (child.exitCode === null) child.kill("SIGTERM");
	}
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		interrupted = true;
		stopChildren();
	});
}

async function waitForFrontend(frontend: Bun.Subprocess) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (frontend.exitCode !== null) {
			throw new Error(`frontend dev proxy exited with code ${frontend.exitCode}`);
		}
		try {
			const response = await fetch(APP_URL, {
				signal: AbortSignal.timeout(750),
			});
			if (response.ok) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error(`frontend dev proxy did not start at ${APP_URL} within 30s`);
}

console.log(`Starting frontend dev proxy at ${APP_URL} ...`);
const frontend = spawn(["bun", "scripts/frontend-dev.ts"], ROOT);

try {
	await waitForFrontend(frontend);
	if (process.platform !== "darwin") {
		throw new Error("app:dev currently requires macOS");
	}
	if (!existsSync(join(MAC_APP_ROOT, "node_modules/electron/package.json"))) {
		console.log("Installing OS¹ shell dependencies ...");
		const install = spawn(
			["bun", "install", "--frozen-lockfile"],
			MAC_APP_ROOT,
		);
		if ((await install.exited) !== 0) {
			throw new Error("OS¹ shell dependency installation failed");
		}
	}

	// Running `electron .` always presents Electron.app's own bundle identity to
	// macOS, so the Dock label remains "Electron" regardless of app.setName().
	// A directory build is fast and gives the dev process the real OS¹ name,
	// icon, identifier, and native vibrancy while the loaded frontend still HMRs.
	console.log("Preparing OS¹ development app ...");
	const packager = spawn(
		["bunx", "electron-builder", "--mac", "--dir", "--publish", "never"],
		MAC_APP_ROOT,
		{ ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
	);
	if ((await packager.exited) !== 0) {
		throw new Error("OS¹ development app packaging failed");
	}
	if (frontend.exitCode !== null) {
		throw new Error(`frontend dev proxy exited with code ${frontend.exitCode}`);
	}
	if (!existsSync(MAC_APP_EXECUTABLE)) {
		throw new Error(`packaged OS¹ executable not found at ${MAC_APP_EXECUTABLE}`);
	}

	console.log("Launching OS¹ ...");
	const electron = spawn([MAC_APP_EXECUTABLE], MAC_APP_ROOT, {
		...process.env,
		OS1_URL: APP_URL,
	});

	const result = await Promise.race([
		frontend.exited.then((code) => ({ process: "frontend", code })),
		electron.exited.then((code) => ({ process: "Electron", code })),
	]);
	if (!interrupted && result.code !== 0) {
		console.error(`${result.process} exited with code ${result.code}`);
	}
	process.exitCode = interrupted ? 130 : result.code;
} catch (error) {
	if (!interrupted) console.error(error instanceof Error ? error.message : error);
	process.exitCode = interrupted ? 130 : 1;
} finally {
	stopChildren();
}
