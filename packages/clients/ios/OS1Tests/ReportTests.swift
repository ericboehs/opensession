import XCTest
@testable import OS1

final class ReportTests: XCTestCase {
    private func decodeGroups(_ json: String) throws -> [ReportGroup] {
        try JSONDecoder().decode(ReportGroupsResponse.self, from: Data(json.utf8)).groups
    }

    /// The shape `GET /api/reports` actually answers with, including the
    /// `highlights` array this app does not decode.
    func testDecodesTheLiveGroupShape() throws {
        let groups = try decodeGroups("""
        {"groups":[{
          "automationId":"auto-019fed31-4348-7000-931e-c704b11ec01c",
          "automationName":"Cassandra",
          "count":65,
          "latest":{
            "id":"2026-08-13-150113-8368",
            "title":"Cassandra review — 2026-08-13 15:00 UTC",
            "automationId":"auto-019fed31-4348-7000-931e-c704b11ec01c",
            "automationName":"Cassandra",
            "sessionId":"os-019ffba3-4c03-7000-82c7-688dd836488b",
            "createdAt":"2026-08-13T15:01:13.188Z",
            "summary":"Quiet review: the window repeats the five deploy announcements.",
            "urgency":"low",
            "confidence":"high",
            "highlights":[{"title":"h","summary":"s","urgency":"low","confidence":"high"}]
          }}]}
        """)
        XCTAssertEqual(groups.count, 1)
        let group = try XCTUnwrap(groups.first)
        XCTAssertEqual(group.name, "Cassandra")
        XCTAssertEqual(group.count, 65)
        XCTAssertEqual(group.latest.urgency, .low)
        XCTAssertEqual(group.latest.confidence, .high)
        XCTAssertNotNil(group.latest.published)
        XCTAssertEqual(group.latest.confidenceNote, "High confidence")
    }

    /// A level this build has never heard of must still draw a row.
    func testUnknownUrgencyAndConfidenceSurvive() throws {
        let groups = try decodeGroups("""
        {"groups":[{"automationId":"a","automationName":"A","count":1,
                    "latest":{"id":"r1","title":"T","automationId":"a",
                              "urgency":"blocker","confidence":"certain"}}]}
        """)
        let latest = try XCTUnwrap(groups.first?.latest)
        XCTAssertEqual(latest.urgency, .unknown)
        XCTAssertEqual(latest.confidence, .unknown)
        // A word the app cannot rank is still worth a badge, and "unstated"
        // is not a confidence worth a line.
        XCTAssertEqual(latest.signal, .unknown)
        XCTAssertNil(latest.confidenceNote)
    }

    /// Only the report's id is required. Everything else is a server that
    /// changed, and a row missing a field beats a list that would not decode.
    func testOnlyTheReportIdIsRequired() throws {
        let groups = try decodeGroups("""
        {"groups":[{"latest":{"id":"r1"}}]}
        """)
        let group = try XCTUnwrap(groups.first)
        XCTAssertEqual(group.latest.title, "Untitled report")
        XCTAssertEqual(group.count, 1)
        XCTAssertNil(group.latest.published)
        // Nothing named the automation anywhere, so there is nothing to
        // draw — the point is that the list still decodes.
        XCTAssertEqual(group.name, "")
    }

    /// A group whose own fields are missing takes them off the report it
    /// carries, which is the same automation by construction.
    func testTheGroupFallsBackToItsLatestReport() throws {
        let groups = try decodeGroups("""
        {"groups":[{"latest":{"id":"r1","title":"T",
                              "automationId":"auto-7","automationName":"Sweep"}}]}
        """)
        let group = try XCTUnwrap(groups.first)
        XCTAssertEqual(group.automationId, "auto-7")
        XCTAssertEqual(group.name, "Sweep")
    }

    func testMissingGroupsDecodesAsEmpty() throws {
        XCTAssertTrue(try decodeGroups("{}").isEmpty)
    }

    func testHistoryDecodesNewestFirstAndToleratesAMissingArray() throws {
        let history = try JSONDecoder().decode(
            ReportHistoryResponse.self,
            from: Data("""
            {"reports":[{"id":"2026-08-13-150113","title":"B","automationId":"a"},
                        {"id":"2026-08-13-140326","title":"A","automationId":"a"}]}
            """.utf8)
        )
        XCTAssertEqual(history.reports.map(\.id), ["2026-08-13-150113", "2026-08-13-140326"])
        XCTAssertTrue(
            try JSONDecoder()
                .decode(ReportHistoryResponse.self, from: Data("{}".utf8))
                .reports
                .isEmpty
        )
    }

    // MARK: - What the row says

    /// The badge is for the reports worth interrupting a morning for. Every
    /// report carries an urgency, so a badge on all of them would be
    /// decoration; "low" is the resting state and says nothing.
    func testOnlyAnUrgencyWorthActingOnGetsABadge() {
        func signal(_ urgency: ReportUrgency?) -> ReportUrgency? {
            ReportMeta(id: "r", title: "T", automationId: "a", urgency: urgency).signal
        }
        XCTAssertNil(signal(nil))
        XCTAssertNil(signal(.low))
        XCTAssertEqual(signal(.medium), .medium)
        XCTAssertEqual(signal(.high), .high)
        XCTAssertEqual(signal(.critical), .critical)
    }

    func testUrgencyLabelsAreSentenceCaseWords() {
        XCTAssertEqual(ReportUrgency.critical.label, "Critical")
        XCTAssertEqual(ReportUrgency.unknown.label, "Flagged")
        XCTAssertEqual(ReportConfidence.unknown.label, "Unstated")
    }
}
