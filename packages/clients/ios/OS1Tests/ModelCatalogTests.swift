import XCTest
@testable import OS1

final class ModelCatalogTests: XCTestCase {
    func testOlderCatalogFallsBackToPi() throws {
        let data = Data("{\"models\":[],\"default\":\"\"}".utf8)
        let catalog = try JSONDecoder().decode(ModelCatalog.self, from: data)
        XCTAssertEqual(catalog.availableEngines.map(\.id), ["pi"])
        XCTAssertEqual(catalog.routingEngine(for: "pi/dial/high"), "pi")
    }

    func testRoutesNativeModelsAndPresetsToPi() {
        XCTAssertEqual(
            ModelCatalog.routedID("claude-opus-5", engine: "pi"),
            "pi/anthropic/claude-opus-5"
        )
        XCTAssertEqual(
            ModelCatalog.routedID("dial/opus-fable", engine: "pi"),
            "pi/dial/opus-fable"
        )
    }

    func testProviderAndKeyParsing() {
        XCTAssertEqual(ModelCatalog.vendor("pi/openai/gpt-5.6-sol"), "openai")
        XCTAssertEqual(ModelCatalog.engineKey("pi/openai/gpt-5.6-sol"), "gpt-5.6-sol")
        XCTAssertEqual(ModelCatalog.engineKey("pi/dial/opus-fable"), "dial/opus-fable")
    }
}
