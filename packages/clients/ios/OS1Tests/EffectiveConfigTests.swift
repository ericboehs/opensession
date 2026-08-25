import XCTest
@testable import OS1

final class EffectiveConfigDecodingTests: XCTestCase {
    func testRequestAttributesConfigToNativeUserWithoutWebSignIn() {
        XCTAssertEqual(
            OS1API.effectiveConfigPath(sessionId: "os-1", user: "Michiel + mobile"),
            "/api/sessions/os-1/effective-config?user=Michiel%20%2B%20mobile"
        )
    }

    func testDecodesCurrentEffectiveConfigShapeAndIgnoresFutureFields() throws {
        let config = try JSONDecoder().decode(
            SessionEffectiveConfig.self,
            from: Data(Self.fixture.utf8)
        )

        XCTAssertEqual(config.session?.id, "os-1")
        XCTAssertEqual(config.model?["dispatchModel"]?.value, .string("pi/anthropic/claude-opus-5"))
        XCTAssertEqual(config.account?["predicted"]?.stability, "load-dependent")
        XCTAssertEqual(config.mcp?.servers?.map(\.name), ["grafana", "stripe"])
        XCTAssertEqual(config.instructions?["sources"]?.source, "pi-runner.ts instructions composition")
    }

    func testStrippedToolDecodesFromDynamicRowValue() throws {
        let config = try JSONDecoder().decode(
            SessionEffectiveConfig.self,
            from: Data(Self.fixture.utf8)
        )
        guard case .array(let values)? = config.tools?["stripped"]?.value else {
            return XCTFail("expected stripped tools")
        }

        let tool = values.compactMap(EffectiveStrippedTool.init(value:)).first
        XCTAssertEqual(tool?.tool, "stripe_create_refund")
        XCTAssertEqual(tool?.ids, ["stripe_create_refund"])
        XCTAssertEqual(tool?.source, "runner-shared.ts STRIPE_CONFIRM_TOOLS")
    }

    static let fixture = #"""
    {
      "session":{"id":"os-1","workspaceId":"ws-1"},
      "resolvedAt":"2026-08-17T10:00:00.000Z",
      "caveat":"Forecast only.",
      "execution":{"mode":{"value":"code","source":"session file mode"}},
      "gate":{"allowed":{"value":true,"source":"run-policy.ts runGateReason"}},
      "model":{
        "requested":{"value":"dial/medium","source":"session file model"},
        "dispatchModel":{"value":"pi/anthropic/claude-opus-5","source":"models.ts routeModel"},
        "engine":{"value":"pi","source":"models.ts routeModel"}
      },
      "account":{"predicted":{"value":{"id":"acct-1","name":"Primary","reason":"most allowance"},"source":"pi-runner.ts pickMeridianAccount","stability":"load-dependent"}},
      "mcp":{
        "scope":{"value":["grafana"],"source":"session-run-inputs.ts"},
        "servers":[
          {"name":"grafana","included":true,"reason":"named by allowlist","source":"mcp-config.json","transport":"remote"},
          {"name":"stripe","included":false,"reason":"outside this run's MCP allowlist","source":"mcp-config.json","transport":"local"}
        ],
        "inProcess":{"servers":{"value":["opensession-sessions"],"source":"interactive-mcp.ts"}}
      },
      "tools":{
        "bashPolicy":{"value":"unrestricted","source":"runner-shared.ts"},
        "stripped":{"value":[{"tool":"stripe_create_refund","ids":["stripe_create_refund"],"source":"runner-shared.ts STRIPE_CONFIRM_TOOLS","reason":"requires approval"}],"source":"run-policy.ts runToolPolicy.disables"}
      },
      "agents":{},"memory":{},"placement":{},"identity":{},
      "instructions":{
        "channel":{"value":"per-prompt system parameter","source":"pi-runner.ts"},
        "sources":{"value":["run-instructions.ts buildRunInstructions","session-repos.ts buildSessionNote"],"source":"pi-runner.ts instructions composition"}
      },
      "futureSection":{"anything":true}
    }
    """#
}

@MainActor
final class EffectiveConfigViewModelTests: XCTestCase {
    func testLoadBuildsResolvedRowsWithTheirSources() async throws {
        let expected = try JSONDecoder().decode(
            SessionEffectiveConfig.self,
            from: Data(EffectiveConfigDecodingTests.fixture.utf8)
        )
        let model = EffectiveConfigViewModel { sessionId in
            XCTAssertEqual(sessionId, "os-1")
            return expected
        }

        await model.load(sessionId: "os-1")

        XCTAssertFalse(model.isLoading)
        XCTAssertNil(model.error)
        XCTAssertEqual(model.modelRows.first?.values, ["pi/anthropic/claude-opus-5"])
        XCTAssertEqual(model.modelRows.first?.source, "models.ts routeModel")
        XCTAssertEqual(model.modelRows.last?.forecast, true)
        XCTAssertEqual(model.mcpRows.first?.source, "session-run-inputs.ts")
        XCTAssertTrue(model.mcpRows[1].values[0].contains("named by allowlist"))
        XCTAssertEqual(model.instructionRows.last?.values.count, 2)
        XCTAssertEqual(model.permissionRows.last?.label, "Removed: stripe_create_refund")
        XCTAssertEqual(
            model.permissionRows.last?.source,
            "runner-shared.ts STRIPE_CONFIRM_TOOLS"
        )
    }

    func testFailureStaysLocalAndRetryCanRecover() async throws {
        enum Failure: LocalizedError { case offline
            var errorDescription: String? { "Server unavailable" }
        }
        let expected = try JSONDecoder().decode(
            SessionEffectiveConfig.self,
            from: Data(EffectiveConfigDecodingTests.fixture.utf8)
        )
        var attempts = 0
        let model = EffectiveConfigViewModel { _ in
            attempts += 1
            if attempts == 1 { throw Failure.offline }
            return expected
        }

        await model.load(sessionId: "os-1")
        XCTAssertEqual(model.error, "Server unavailable")
        XCTAssertNil(model.config)

        await model.load(sessionId: "os-1")
        XCTAssertNil(model.error)
        XCTAssertEqual(model.config?.session?.id, "os-1")
    }
}
