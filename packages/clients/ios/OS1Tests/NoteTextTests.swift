import XCTest
@testable import OS1

final class NoteTextTests: XCTestCase {
    private func tokens(_ text: String) -> [NoteText.Token] { NoteText.tokens(text) }

    func testPlainTextIsOneToken() {
        XCTAssertEqual(tokens("just a line"), [.plain("just a line")])
    }

    func testEmptyTextHasNoTokens() {
        XCTAssertEqual(tokens(""), [])
    }

    func testMentionIsItsOwnToken() {
        XCTAssertEqual(
            tokens("ping @Kent about it"),
            [.plain("ping "), .mention("@Kent"), .plain(" about it")]
        )
    }

    func testMentionStartingTheLine() {
        XCTAssertEqual(tokens("@Kent look"), [.mention("@Kent"), .plain(" look")])
    }

    /// The web bolds `@example.com` out of an address, which reads as a mention
    /// of a person who does not exist. A mention has to follow a non-word
    /// character here.
    func testEmailAddressIsNotAMention() {
        XCTAssertEqual(tokens("mail alex@example.com"), [.plain("mail alex@example.com")])
    }

    func testUrlBecomesALink() {
        let parts = tokens("see https://tella.tv/x now")
        XCTAssertEqual(parts.first, .plain("see "))
        XCTAssertEqual(parts.last, .plain(" now"))
        guard case .link(let value, let url)? = parts.dropFirst().first else {
            return XCTFail("expected a link token, got \(parts)")
        }
        XCTAssertEqual(value, "https://tella.tv/x")
        XCTAssertEqual(url.absoluteString, "https://tella.tv/x")
    }

    /// Same character class the web uses: a closing bracket or quote ends the
    /// URL, so a link written inside parentheses does not swallow them.
    func testUrlStopsAtAClosingParenthesis() {
        let parts = tokens("(https://tella.tv/x)")
        XCTAssertEqual(parts.first, .plain("("))
        XCTAssertEqual(parts.last, .plain(")"))
        guard case .link(let value, _)? = parts.dropFirst().first else {
            return XCTFail("expected a link token, got \(parts)")
        }
        XCTAssertEqual(value, "https://tella.tv/x")
    }

    func testBareHostIsNotALink() {
        XCTAssertEqual(tokens("tella.tv is up"), [.plain("tella.tv is up")])
    }

    func testMentionAndLinkInOneNote() {
        XCTAssertEqual(
            tokens("@Kent https://tella.tv"),
            [
                .mention("@Kent"),
                .plain(" "),
                .link("https://tella.tv", URL(string: "https://tella.tv")!),
            ]
        )
    }

    /// Nothing may be dropped: the bubble renders these tokens instead of the
    /// string, so a lost character is a lost word.
    func testTokensRejoinToTheOriginal() {
        let samples = [
            "@Kent see https://tella.tv/a, then @Michiel — thanks",
            "no tokens at all",
            "line one\n\nline two @a",
            "@@weird @1notaname user@host.com",
        ]
        for sample in samples {
            let joined = tokens(sample).map { token -> String in
                switch token {
                case .plain(let value): value
                case .mention(let value): value
                case .link(let value, _): value
                }
            }.joined()
            XCTAssertEqual(joined, sample)
        }
    }

    func testNewlinesSurviveAsPlainText() {
        XCTAssertEqual(tokens("a\nb"), [.plain("a\nb")])
    }

    func testAttributedMarksMentionsAndLinks() {
        let value = NoteText.attributed("@Kent https://tella.tv")
        var mentions = 0
        var links = 0
        for run in value.runs {
            if run.inlinePresentationIntent == .stronglyEmphasized { mentions += 1 }
            if run.link != nil { links += 1 }
        }
        XCTAssertEqual(mentions, 1)
        XCTAssertEqual(links, 1)
        XCTAssertEqual(String(value.characters), "@Kent https://tella.tv")
    }
}
