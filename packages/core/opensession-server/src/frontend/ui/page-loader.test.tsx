import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PageLoader } from "./page-loader";

test("page loading uses the larger round spinner", () => {
	const html = renderToStaticMarkup(<PageLoader className="text-dim" />);
	expect(html).toContain("rounded-full");
	expect(html).toContain("size-5");
	expect(html).toContain("animate-spin");
	expect(html).toContain("text-dim");
	expect(html.match(/<span/g)).toHaveLength(1);
});
