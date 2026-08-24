import XCTest
@testable import OS1

final class SocketMutationOutboxTests: XCTestCase {
    func testMutationSurvivesReplacementUntilReceipt() throws {
        let suite = "SocketMutationOutboxTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = SocketMutationOutbox(defaults: defaults, key: "commands")
        let prepared = try XCTUnwrap(first.prepare([
            "type": "answer_question", "sessionId": "s1", "questionId": "q1",
            "answers": NSNull(),
        ]))
        let requestId = try XCTUnwrap(prepared.frame["requestId"] as? String)

        let resumed = SocketMutationOutbox(defaults: defaults, key: "commands")
        XCTAssertEqual(resumed.pendingTexts(), [prepared.text])
        XCTAssertTrue(resumed.acknowledge(id: requestId, sessionId: "s1"))
        XCTAssertTrue(resumed.pendingTexts().isEmpty)
        XCTAssertEqual(resumed.pendingAckTexts().count, 1)

        let relaunched = SocketMutationOutbox(defaults: defaults, key: "commands")
        XCTAssertEqual(relaunched.pendingAckTexts(), resumed.pendingAckTexts())
        XCTAssertTrue(relaunched.confirmAcknowledgement(id: requestId))
        XCTAssertTrue(relaunched.pendingAckTexts().isEmpty)
    }

    func testDoesNotEvictUnresolvedCommandsPastOneHundred() throws {
        let suite = "SocketMutationOutboxTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let outbox = SocketMutationOutbox(defaults: defaults, key: "commands")
        for index in 0..<101 {
            _ = try XCTUnwrap(outbox.prepare([
                "type": "cancel", "sessionId": "s\(index)",
            ]))
        }
        XCTAssertEqual(outbox.pendingTexts().count, 101)
    }

    func testReadFramesAreNotPersisted() throws {
        let suite = "SocketMutationOutboxTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let outbox = SocketMutationOutbox(defaults: defaults, key: "commands")
        let prepared = try XCTUnwrap(outbox.prepare(["type": "watch", "sessionId": "s1"]))
        XCTAssertNil(prepared.frame["requestId"])
        XCTAssertTrue(outbox.pendingTexts().isEmpty)
    }

    func testLegacyOneShotMutationIsNotPersisted() throws {
        let suite = "SocketMutationOutboxTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let outbox = SocketMutationOutbox(defaults: defaults, key: "commands")
        let prepared = try XCTUnwrap(outbox.prepare(["type": "cancel"], persistMutation: false))
        XCTAssertNotNil(prepared.frame["requestId"])
        XCTAssertTrue(outbox.pendingTexts().isEmpty)
    }

}
