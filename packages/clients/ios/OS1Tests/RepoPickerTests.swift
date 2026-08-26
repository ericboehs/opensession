import XCTest
@testable import OS1

/// The add-a-repository picker filters the same way the web one does
/// (`filterRepos` in src/frontend/components/SetupRepos.tsx): case-insensitive
/// substring over the full name AND the description, because on a phone the
/// list is 300 rows long and the owner prefix is the same on most of them.
@MainActor
final class RepoPickerTests: XCTestCase {
    private func repos(_ json: String) throws -> [OS1API.BrowsableRepo] {
        try JSONDecoder().decode([OS1API.BrowsableRepo].self, from: Data(json.utf8))
    }

    private let fixture = """
    [
      {"fullName":"tellahq/tella-fusion","private":true,"description":"The main app","defaultBranch":"main","registered":true},
      {"fullName":"tellahq/gstreamer","private":false,"defaultBranch":"main","registered":false},
      {"fullName":"acme/Widget","private":false,"description":"Recording pipeline","defaultBranch":"trunk","registered":false}
    ]
    """

    func testEmptyQueryKeepsServerOrder() throws {
        let all = try repos(fixture)
        XCTAssertEqual(
            RepoPicker.matching(all, query: "   ").map(\.fullName),
            all.map(\.fullName)
        )
    }

    func testMatchesFullNameCaseInsensitively() throws {
        let all = try repos(fixture)
        XCTAssertEqual(
            RepoPicker.matching(all, query: "WIDGET").map(\.fullName),
            ["acme/Widget"]
        )
    }

    /// The description has to match too. "recording" names no repo here, and
    /// a filter that only read names would answer nothing for it.
    func testMatchesDescription() throws {
        let all = try repos(fixture)
        XCTAssertEqual(
            RepoPicker.matching(all, query: "recording").map(\.fullName),
            ["acme/Widget"]
        )
    }

    func testNoMatchIsEmptyRatherThanEverything() throws {
        XCTAssertTrue(RepoPicker.matching(try repos(fixture), query: "zzz").isEmpty)
    }

    /// `private` is a Swift keyword and a JSON key here, so the coding key is
    /// hand-written — a rename would silently make every repo look public.
    func testDecodesPrivateAndRegisteredFlags() throws {
        let all = try repos(fixture)
        XCTAssertEqual(all[0].isPrivate, true)
        XCTAssertEqual(all[0].registered, true)
        XCTAssertEqual(all[1].isPrivate, false)
        XCTAssertNil(all[1].description)
    }
}
