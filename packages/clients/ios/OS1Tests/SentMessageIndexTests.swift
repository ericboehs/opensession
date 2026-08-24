import XCTest
@testable import OS1

final class SentMessageIndexTests: XCTestCase {
    private func entry(_ json: String) throws -> TranscriptEntry {
        try JSONDecoder().decode(TranscriptEntry.self, from: Data(json.utf8))
    }

    private func collect(
        _ entries: [TranscriptEntry],
        owner: String? = "Michiel",
        me: String = "Michiel",
        login: String = "happylinks"
    ) -> [SentMessageAnchor] {
        SentMessageIndex.collect(
            from: entries,
            owner: owner,
            viewerName: me,
            viewerLogin: login
        )
    }

    func testCollectsOnlyRenderedMessagesByTheViewer() throws {
        let messages = collect([
            try entry(#"{"id":"mine","type":"user","content":"Ship the native rail","timestamp":"2026-08-17T09:00:00Z"}"#),
            try entry(#"{"id":"theirs","type":"user","content":"Check this","sender":"Kent"}"#),
            try entry(#"{"id":"answer","type":"assistant","content":"Done"}"#),
            try entry(#"{"id":"notice","type":"user","content":"Delivery plumbing","notice":{"kind":"system","title":"Queued","tone":"info"}}"#),
            try entry(#"{"id":"empty","type":"user","content":""}"#),
        ])

        XCTAssertEqual(messages.map(\.id), ["mine"])
        XCTAssertEqual(messages.first?.preview, "Ship the native rail")
        XCTAssertNotNil(messages.first?.timestamp)
    }

    func testExplicitViewerSenderWinsInATeammatesSession() throws {
        let messages = collect([
            try entry(#"{"id":"owner","type":"user","content":"Kent's prompt"}"#),
            try entry(#"{"id":"steer","type":"user","content":"My steer","sender":"happylinks"}"#),
        ], owner: "Kent")

        XCTAssertEqual(messages.map(\.id), ["steer"])
    }

    func testIdentityShapesAndAttachmentsAreIndexed() throws {
        let messages = collect([
            try entry(#"{"id":"full-name","type":"user","content":"One","sender":"Michiel Westerbeek"}"#),
            try entry(#"{"id":"login","type":"user","content":"","images":["/media?path=one.png","/media?path=two.png"],"sender":"happylinks"}"#),
        ], owner: nil)

        XCTAssertEqual(messages.map(\.preview), ["One", "2 images"])
    }

    func testPreviewDropsLeadingQuoteAndClampsLongText() throws {
        let long = String(repeating: "message ", count: 30)
        let data = try JSONSerialization.data(withJSONObject: [
            "id": "quoted",
            "type": "user",
            "content": "> selected line\n> another line\n\n\(long)",
        ])
        let message = try JSONDecoder().decode(TranscriptEntry.self, from: data)
        let preview = try XCTUnwrap(collect([message]).first?.preview)

        XCTAssertFalse(preview.contains("selected line"))
        XCTAssertTrue(preview.hasSuffix("…"))
        XCTAssertLessThanOrEqual(preview.count, 121)
    }
}
