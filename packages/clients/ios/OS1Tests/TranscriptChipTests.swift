import XCTest
@testable import OS1

/// A chip travels as a marker link with its label in the query, which is
/// unreadable inside an expectation. This turns one back into the
/// `[label](destination)` it stands for, so the rewrite suites keep asserting
/// the RULE — which references become chips — rather than the wire format,
/// which is this file's business.
func chipsAsLinks(_ markdown: String) -> String {
    let pattern = try! NSRegularExpression(pattern: "\\[os1chip\\]\\(([^)\\s]+)\\)")
    let ns = markdown as NSString
    var result = ""
    var cursor = 0
    for match in pattern.matches(in: markdown, range: NSRange(location: 0, length: ns.length)) {
        let destination = ns.substring(with: match.range(at: 1))
        guard let url = URL(string: destination),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: true)
        else { continue }
        let title = components.queryItems?.first { $0.name == "chipTitle" }?.value ?? ""
        components.query = nil
        result += ns.substring(with: NSRange(
            location: cursor,
            length: match.range.location - cursor
        ))
        result += "[\(title)](\(components.string ?? destination))"
        cursor = match.range.location + match.range.length
    }
    result += ns.substring(from: cursor)
    return result
}

/// The value inside one of a chip's own query parameters.
func chipParameter(_ name: String, in markdown: String) -> String? {
    guard let start = markdown.range(of: "[os1chip]("),
          let end = markdown.range(of: ")", range: start.upperBound..<markdown.endIndex),
          let url = URL(string: String(markdown[start.upperBound..<end.lowerBound])),
          let components = URLComponents(url: url, resolvingAgainstBaseURL: true)
    else { return nil }
    return components.queryItems?.first { $0.name == name }?.value
}

@MainActor
final class TranscriptChipTests: XCTestCase {
    private let chip = TranscriptChip(
        kind: .pullRequest,
        tone: .purple,
        title: "PR #5528",
        accessibilityLabel: "Open PR 5528 · Merged",
        destination: "os1pr:opensession/5528"
    )

    /// Everything the drawing needs has to survive the trip out through a
    /// markdown link and back through the renderer's payload.
    func testAChipSurvivesItsOwnEncoding() throws {
        let markdown = chip.markdown
        let destination = try XCTUnwrap(
            markdown.range(of: "[os1chip](").map { String(markdown[$0.upperBound...].dropLast()) }
        )
        let url = try XCTUnwrap(URL(string: destination))
        let payload = try JSONEncoder().encode(Payload(
            type: "citation",
            title: chip.title,
            accessibilityLabel: chip.accessibilityLabel,
            url: url
        ))
        let rendered = try XCTUnwrap(TranscriptChip.rendered(payload: payload))
        XCTAssertEqual(rendered.kind, .pullRequest)
        XCTAssertEqual(rendered.tone, .purple)
        XCTAssertEqual(rendered.title, "PR #5528")
        XCTAssertEqual(rendered.accessibilityLabel, "Open PR 5528 · Merged")
    }

    /// The `#` in a PR label and the space in a session title are the two
    /// characters that would silently truncate a destination — one starts a
    /// fragment, the other ends the link.
    func testTheLabelCannotBreakOutOfTheDestination() {
        let markdown = TranscriptChip(
            kind: .session,
            tone: .neutral,
            title: "Fix #5528 (again)",
            accessibilityLabel: "Open Fix #5528 (again)",
            destination: "os1session:os-019fcead-adc4-7000-b0da-8a5af66819c7"
        ).markdown
        XCTAssertFalse(markdown.dropFirst("[os1chip](".count).contains(" "))
        XCTAssertEqual(chipParameter("chipTitle", in: markdown), "Fix #5528 (again)")
        XCTAssertEqual(markdown.filter { $0 == ")" }.count, 1)
    }

    /// The chip hangs its payload off the destination the tap already used, so
    /// the three schemes must still read their id out of one. This is the
    /// whole reason the payload could ride in the query at all.
    func testEveryDestinationStillResolvesWithAChipsQueryOnIt() throws {
        let session = "os-019fcead-adc4-7000-b0da-8a5af66819c7"
        let sessionChip = SessionLinks.chip(for: session).markdown
        let url = try XCTUnwrap(URL(string: try XCTUnwrap(destination(of: sessionChip))))
        XCTAssertEqual(SessionLinks.sessionId(from: url), session)

        let asset = try XCTUnwrap(URL(string: "os1asset:viz/index.html?chipTitle=index.html"))
        XCTAssertEqual(AssetLinks.path(from: asset), "viz/index.html")

        let pr = try XCTUnwrap(URL(string: "os1pr:opensession/5528?chipTone=green"))
        XCTAssertEqual(PrLinks.reference(from: pr)?.number, 5528)
        XCTAssertEqual(PrLinks.reference(from: pr)?.repo, "opensession")
    }

    private func destination(of markdown: String) -> String? {
        guard let start = markdown.range(of: "[os1chip]("),
              let end = markdown.range(of: ")", range: start.upperBound..<markdown.endIndex)
        else { return nil }
        return String(markdown[start.upperBound..<end.lowerBound])
    }

    /// Mirrors what `InlineCitationAttachment` hands the view provider.
    private struct Payload: Encodable {
        let type: String
        let title: String
        let accessibilityLabel: String
        let url: URL
    }
}
