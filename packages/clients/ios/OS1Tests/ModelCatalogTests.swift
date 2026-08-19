import XCTest
@testable import OS1

final class ModelCatalogTests: XCTestCase {
    func testDecodesEnginesAndPerModelDefaults() throws {
        let data = Data(
            """
            {
              "models": [{"id":"opencode/anthropic/claude-opus-5","label":"Opus 5"}],
              "default": "opencode/anthropic/claude-opus-5",
              "engines": [
                {"id":"opencode","label":"OpenCode","available":true},
                {"id":"claude","label":"Claude","available":true},
                {"id":"codex","label":"Codex","available":false}
              ],
              "modelEngines": {"claude-opus-5":"claude"}
            }
            """.utf8
        )

        let catalog = try JSONDecoder().decode(ModelCatalog.self, from: data)

        XCTAssertEqual(catalog.availableEngines.map(\.id), ["opencode", "claude"])
        XCTAssertEqual(catalog.modelEngines?["claude-opus-5"], "claude")
        XCTAssertEqual(
            catalog.routingEngine(for: "opencode/anthropic/claude-opus-5"),
            "claude"
        )
    }

    func testOlderCatalogFallsBackToOpenCode() throws {
        let data = Data("{\"models\":[],\"default\":\"\"}".utf8)
        let catalog = try JSONDecoder().decode(ModelCatalog.self, from: data)

        XCTAssertEqual(catalog.availableEngines.map(\.id), ["opencode"])
        XCTAssertEqual(catalog.routingEngine(for: "dial/high"), "opencode")
    }

    func testBaseIDNormalizesEveryRoutingPrefix() {
        XCTAssertEqual(
            ModelCatalog.baseID("opencode/anthropic/claude-opus-5"),
            "opencode/anthropic/claude-opus-5"
        )
        XCTAssertEqual(
            ModelCatalog.baseID("pi/anthropic/claude-opus-5"),
            "opencode/anthropic/claude-opus-5"
        )
        XCTAssertEqual(
            ModelCatalog.baseID("claude/workspace-preset/ws-1/review"),
            "workspace-preset/ws-1/review"
        )
        XCTAssertEqual(
            ModelCatalog.baseID("codex/orchestrator/high"),
            "orchestrator/high"
        )
        XCTAssertEqual(ModelCatalog.baseID("pi/dial/ultra"), "dial/ultra")
    }

    func testRoutesModelsAcrossCompatibleEngines() {
        let anthropic = "opencode/anthropic/claude-opus-5"
        let openAI = "opencode/openai/gpt-5.6-sol"

        XCTAssertEqual(
            ModelCatalog.routedID(anthropic, engine: "claude"),
            "claude/anthropic/claude-opus-5"
        )
        XCTAssertEqual(
            ModelCatalog.routedID(openAI, engine: "codex"),
            "codex/openai/gpt-5.6-sol"
        )
        XCTAssertEqual(
            ModelCatalog.routedID(anthropic, engine: "pi"),
            "pi/anthropic/claude-opus-5"
        )
        XCTAssertEqual(ModelCatalog.routedID("pi/dial/high", engine: "opencode"), "dial/high")
        XCTAssertNil(ModelCatalog.routedID(openAI, engine: "claude"))
        XCTAssertNil(ModelCatalog.routedID(anthropic, engine: "codex"))
        XCTAssertNil(ModelCatalog.routedID("claude-opus-5", engine: "claude"))
    }

    func testPresetsRemainRoutableOnDirectEngines() {
        XCTAssertEqual(
            ModelCatalog.routedID("workspace-preset/ws-1/review", engine: "claude"),
            "claude/workspace-preset/ws-1/review"
        )
        XCTAssertEqual(
            ModelCatalog.routedID("orchestrator/high", engine: "codex"),
            "codex/orchestrator/high"
        )
    }

    func testExplicitEngineOutranksPerModelDefault() {
        let catalog = ModelCatalog(
            models: [],
            defaultModel: nil,
            engines: [
                ModelEngineOption(id: "opencode", label: "OpenCode", available: true),
                ModelEngineOption(id: "claude", label: "Claude", available: true),
                ModelEngineOption(id: "pi", label: "Pi", available: true),
            ],
            modelEngines: ["claude-opus-5": "claude"]
        )

        XCTAssertEqual(
            catalog.routingEngine(for: "pi/anthropic/claude-opus-5"),
            "pi"
        )
        XCTAssertEqual(
            catalog.routingEngine(for: "opencode/anthropic/claude-opus-5"),
            "claude"
        )
    }

    func testRoutedWorkspacePresetResolvesCatalogOption() throws {
        let data = Data(
            """
            {
              "models": [{"id":"workspace-preset/ws-1/review","label":"Review"}],
              "default": "workspace-preset/ws-1/review"
            }
            """.utf8
        )
        let catalog = try JSONDecoder().decode(ModelCatalog.self, from: data)

        XCTAssertEqual(
            catalog.option(for: "claude/workspace-preset/ws-1/review")?.displayLabel,
            "Review"
        )
    }

    func testPreferredIDStartsANewSessionOnAPersonalEngine() throws {
        let data = Data(
            """
            {
              "models": [{"id":"opencode/anthropic/claude-opus-5","label":"Opus 5"}],
              "default": "dial/opus-fable",
              "engines": [
                {"id":"opencode","label":"OpenCode","available":true},
                {"id":"pi","label":"Pi","available":true},
                {"id":"claude","label":"Claude","available":true},
                {"id":"codex","label":"Codex","available":false}
              ]
            }
            """.utf8
        )
        let catalog = try JSONDecoder().decode(ModelCatalog.self, from: data)

        XCTAssertEqual(
            catalog.preferredID("opencode/anthropic/claude-opus-5", engine: "pi"),
            "pi/anthropic/claude-opus-5"
        )
        XCTAssertEqual(
            catalog.preferredID("dial/opus-fable", engine: "pi"),
            "pi/dial/opus-fable"
        )
        // No preference, and OpenCode is the unprefixed base form rather than
        // a prefix of its own.
        XCTAssertEqual(catalog.preferredID("dial/opus-fable", engine: ""), "dial/opus-fable")
        XCTAssertEqual(
            catalog.preferredID("opencode/anthropic/claude-opus-5", engine: "opencode"),
            "opencode/anthropic/claude-opus-5"
        )
        // Fail-soft: an engine this instance no longer offers, a model whose
        // vendor the engine does not serve, and an id with no prefixable shape
        // all keep the unprefixed id.
        XCTAssertEqual(catalog.preferredID("dial/opus-fable", engine: "codex"), "dial/opus-fable")
        XCTAssertEqual(
            catalog.preferredID("opencode/openai/gpt-5.6-sol", engine: "claude"),
            "opencode/openai/gpt-5.6-sol"
        )
        XCTAssertEqual(catalog.preferredID("claude-opus-5", engine: "pi"), "claude-opus-5")
    }

    @MainActor
    func testWorkspaceCatalogPathEncodesQueryValue() {
        let path = OS1API.modelsPath(workspaceId: "ws/a b")
        let components = URLComponents(string: path)

        XCTAssertFalse(path.contains(" "))
        XCTAssertEqual(components?.path, "/api/models")
        XCTAssertEqual(components?.queryItems?.first?.name, "workspace")
        XCTAssertEqual(components?.queryItems?.first?.value, "ws/a b")
        XCTAssertEqual(OS1API.modelsPath(workspaceId: nil), "/api/models")
    }
}
