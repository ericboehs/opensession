import XCTest
@testable import OS1

final class SessionCreateIntentTests: XCTestCase {
    func testReusesTheRequestIdUntilAcknowledged() throws {
        let suite = "SessionCreateIntentTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let intent = SessionCreateIntent(defaults: defaults, key: "create")
        let body: [String: Any] = ["prompt": "Build it", "mode": "code"]
        let first = intent.requestId(for: body)
        XCTAssertEqual(SessionCreateIntent(defaults: defaults, key: "create").requestId(for: body), first)
        XCTAssertEqual(
            intent.requestId(for: ["prompt": "Build it", "mode": "code", "requestId": UUID().uuidString]),
            first
        )
        intent.complete(requestId: first)
        XCTAssertNotEqual(intent.requestId(for: body), first)
    }

    func testKeepsDistinctUnresolvedCreatesIndependently() throws {
        let suite = "SessionCreateIntentTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let intent = SessionCreateIntent(defaults: defaults, key: "create")
        let firstBody: [String: Any] = ["prompt": "First", "mode": "ask"]
        let secondBody: [String: Any] = ["prompt": "Second", "mode": "ask"]
        let first = intent.requestId(for: firstBody)
        let second = intent.requestId(for: secondBody)
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(intent.requestId(for: firstBody), first)
        intent.complete(requestId: second)
        XCTAssertEqual(intent.requestId(for: firstBody), first)
    }

}
