import XCTest
@testable import OS1

final class SupportThreadTests: XCTestCase {
    /// Plain can't post as a workspace user, so the server glues the author's
    /// name onto the note body. Leaving that in place would show markup where
    /// a name belongs.
    func testNotePrefixIsUnpicked() {
        let raw = "**Kent (via Open Session):**\n\nRefunded, waiting on Stripe."
        let unpicked = SupportNote.unpick(raw)
        XCTAssertEqual(unpicked.author, "Kent")
        XCTAssertEqual(unpicked.body, "Refunded, waiting on Stripe.")
    }

    /// The server hardcodes its own product name in the prefix while the web
    /// writes whatever it is branded as, so the match can't be literal.
    func testAnyProductNameInThePrefix() {
        let unpicked = SupportNote.unpick("**Michiel (via Backstage):**\nlooking")
        XCTAssertEqual(unpicked.author, "Michiel")
        XCTAssertEqual(unpicked.body, "looking")
    }

    func testNoteWithoutAPrefixIsLeftAlone() {
        let raw = "**Bold** opening, no attribution here."
        let unpicked = SupportNote.unpick(raw)
        XCTAssertNil(unpicked.author)
        XCTAssertEqual(unpicked.body, raw)
    }

    func testPriorityLanesCoverTheMissingOnes() {
        // Plain leaves priority off sometimes; the web treats that as Normal
        // rather than dropping the row.
        XCTAssertEqual(summary(priority: nil).lane, .normal)
        XCTAssertEqual(summary(priority: 0).lane, .urgent)
        XCTAssertEqual(summary(priority: 3).lane, .low)
        // An unknown number is not a lane of its own.
        XCTAssertEqual(summary(priority: 9).lane, .normal)
    }

    func testRowFallsBackFromNameToEmailToUnknown() {
        XCTAssertEqual(summary(name: "Ada", email: "a@b.c").customerLabel, "Ada")
        XCTAssertEqual(summary(name: "  ", email: "a@b.c").customerLabel, "a@b.c")
        XCTAssertEqual(summary(name: nil, email: nil).customerLabel, "Unknown customer")
    }

    func testTitleFallsBackToThePreview() {
        XCTAssertEqual(
            summary(title: nil, preview: "my export is stuck").displayTitle,
            "my export is stuck"
        )
        XCTAssertEqual(summary(title: nil, preview: nil).displayTitle, "Untitled ticket")
    }

    /// Reads carry Plain's uppercase status; writes take the lowercase one.
    func testStatusReadingIsCaseInsensitive() throws {
        let json = """
        {"id":"th_1","status":"DONE","entries":[]}
        """.data(using: .utf8)!
        let thread = try JSONDecoder().decode(SupportThread.self, from: json)
        XCTAssertTrue(thread.isDone)
        XCTAssertFalse(thread.isSnoozed)
    }

    /// Server additions must never break an older build: the payload here
    /// carries fields this app doesn't know and omits ones it does.
    func testDecodingToleratesAnUnknownShape() throws {
        let json = """
        {"id":"th_2","title":null,"somethingNew":{"a":1},
         "customer":{"name":"Ada","email":null,"isSpam":false},
         "entries":[{"id":"e1","text":"hi","kind":"chat","actorType":"customer"}]}
        """.data(using: .utf8)!
        let thread = try JSONDecoder().decode(SupportThread.self, from: json)
        XCTAssertEqual(thread.customerLabel, "Ada")
        XCTAssertEqual(thread.entries?.first?.isFromCustomer, true)
        XCTAssertEqual(thread.entries?.first?.isNote, false)
    }

    // MARK: - Helpers

    private func summary(
        priority: Int? = 2,
        name: String? = "Ada",
        email: String? = "ada@example.com",
        title: String? = "Export stuck",
        preview: String? = "hello"
    ) -> SupportThreadSummary {
        let payload: [String: Any?] = [
            "id": "th_x",
            "title": title,
            "previewText": preview,
            "priority": priority,
            "customer": ["name": name, "email": email],
        ]
        let data = try! JSONSerialization.data(
            withJSONObject: payload.compactMapValues { $0 ?? NSNull() }
        )
        return try! JSONDecoder().decode(SupportThreadSummary.self, from: data)
    }
}
