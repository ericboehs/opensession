import homepage from "../website/index.html";

const port = Number(process.env.PORT || 3865);

Bun.serve({
	port,
	hostname: "127.0.0.1",
	routes: {
		"/": homepage,
	},
	development: {
		hmr: true,
		console: true,
	},
});

console.log(`OpenSession website: http://127.0.0.1:${port}`);
