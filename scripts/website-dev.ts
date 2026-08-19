import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildWebsiteTailwind } from "./website-tailwind";

const root = join(import.meta.dir, "..");
await buildWebsiteTailwind(root);
const [{ default: homepage }, { default: productDemo }, { default: setup }] = await Promise.all([
	import("../packages/clients/website/index.html"),
	import("../packages/clients/website/product-demo.html"),
	import("../packages/clients/website/setup.html"),
]);

const port = Number(process.env.PORT || 3865);

/**
 * The waitlist, for now: one markdown file of addresses. It lives outside the
 * repo by default so signups can never ride along in a commit; point
 * OPENSESSION_WAITLIST_FILE somewhere else to move it.
 */
const waitlistFile =
	process.env.OPENSESSION_WAITLIST_FILE ||
	join(homedir(), ".opensession-waitlist.md");

const isEmail = (value: string) =>
	value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

async function joinWaitlist(request: Request): Promise<Response> {
	const body = (await request.json().catch(() => null)) as {
		email?: unknown;
	} | null;
	const email = typeof body?.email === "string" ? body.email.trim() : "";
	if (!isEmail(email))
		return Response.json({ error: "invalid email" }, { status: 400 });

	const existing = await readFile(waitlistFile, "utf8").catch(() => null);
	if (existing === null) {
		await mkdir(dirname(waitlistFile), { recursive: true });
		await writeFile(waitlistFile, "# Waitlist\n\n");
	} else if (existing.toLowerCase().includes(`- ${email.toLowerCase()} `)) {
		return Response.json({ ok: true, duplicate: true });
	}
	await appendFile(waitlistFile, `- ${email} · ${new Date().toISOString()}\n`);
	console.log(`waitlist: ${email}`);
	return Response.json({ ok: true });
}

Bun.serve({
	port,
	hostname: "127.0.0.1",
	routes: {
		"/": homepage,
		"/product-demo.html": productDemo,
		"/setup": setup,
		"/setup/": setup,
		"/setup.html": setup,
		"/api/waitlist": { POST: joinWaitlist },
	},
	development: {
		hmr: true,
		console: true,
	},
});

console.log(`Open Session website: http://127.0.0.1:${port}`);
console.log(`Waitlist signups: ${waitlistFile}`);
