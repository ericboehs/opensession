import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SetupIntegration } from "./setup-shared";
import { IntegrationsList } from "./SetupIntegrations";

const integration: SetupIntegration = {
	id: "linear",
	label: "Linear",
	doc: "",
	enabled: false,
	env: [],
	links: [],
	missingRequired: ["LINEAR_API_KEY"],
};

function renderIntegration(enabled: boolean): string {
	return renderToStaticMarkup(
		<IntegrationsList
			integrations={[{ ...integration, enabled }]}
			onSaved={() => {}}
		/>,
	);
}

describe("integration credential warnings", () => {
	test("hides missing credentials while the integration is off", () => {
		expect(renderIntegration(false)).not.toContain("Missing LINEAR_API_KEY");
	});

	test("shows missing credentials while the integration is on", () => {
		expect(renderIntegration(true)).toContain("Missing LINEAR_API_KEY");
	});
});
