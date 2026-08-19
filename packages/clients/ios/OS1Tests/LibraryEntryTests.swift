import XCTest
@testable import OS1

/// The library is derived server-side and grows without this app shipping, so
/// what is tested here is mostly tolerance: a newer instance's payload must
/// still decode into a usable list.
final class LibraryEntryTests: XCTestCase {
    private func decode(_ json: String) throws -> [LibraryEntry] {
        struct Response: Decodable { let entries: [LibraryEntry] }
        return try JSONDecoder()
            .decode(Response.self, from: Data(json.utf8))
            .entries
    }

    func testDecodesARecipeWithItsPrompt() throws {
        let entries = try decode("""
        {"entries":[{"id":"automation:stale-pr-monitor","type":"automation",
        "slug":"stale-pr-monitor","name":"Stale PR monitor",
        "description":"Weekly list of pull requests that have gone quiet.",
        "category":"Automation","requires":["github"],"install":"one-click",
        "installed":false,"href":"/settings/automations","source":"repo",
        "prompt":"List the open pull requests.","mode":"ask"}]}
        """)
        let entry = try XCTUnwrap(entries.first)
        XCTAssertEqual(entry.kind, .automation)
        XCTAssertEqual(entry.name, "Stale PR monitor")
        XCTAssertEqual(entry.prompt, "List the open pull requests.")
        XCTAssertEqual(entry.mode, "ask")
        XCTAssertEqual(entry.requires, ["github"])
        XCTAssertTrue(entry.fromRepo)
        XCTAssertTrue(entry.isStartable)
    }

    func testAnUnknownKindDecodesRatherThanThrowing() throws {
        let entries = try decode("""
        {"entries":[
          {"id":"skill:review","type":"skill","slug":"review","name":"Review",
           "description":"","category":"Skill","install":"remote",
           "installed":null,"href":"/settings/skills","source":"repo"},
          {"id":"tool:notes","type":"tool","slug":"notes","name":"Notes",
           "description":"Shared documents.","category":"Work",
           "install":"client","installed":null,"href":"/settings/notes",
           "source":"builtin"}
        ]}
        """)
        XCTAssertEqual(entries.count, 2)
        XCTAssertEqual(entries[0].kind, .unknown("skill"))
        XCTAssertEqual(entries[1].kind, .tool)
        // Neither can start a session, so neither reaches the list.
        XCTAssertFalse(entries.contains(where: \.isStartable))
    }

    func testEverythingButTheIdIsOptional() throws {
        let entries = try decode(#"{"entries":[{"id":"automation:bare"}]}"#)
        let entry = try XCTUnwrap(entries.first)
        XCTAssertEqual(entry.slug, "automation:bare")
        XCTAssertEqual(entry.name, "automation:bare")
        XCTAssertEqual(entry.summary, "")
        XCTAssertEqual(entry.requires, [])
        XCTAssertEqual(entry.kind, .unknown(""))
        XCTAssertFalse(entry.isStartable)
    }

    /// A server that predates the prompt field still serves automations. They
    /// would prefill an empty composer, so they are not offered.
    func testAnAutomationWithoutAPromptIsNotStartable() throws {
        let entries = try decode("""
        {"entries":[{"id":"automation:old","type":"automation","slug":"old",
        "name":"Old","description":"","category":"Automation",
        "install":"one-click","installed":false,"href":"/settings/automations",
        "source":"repo"},
        {"id":"automation:blank","type":"automation","slug":"blank",
        "name":"Blank","description":"","category":"Automation",
        "install":"draft","installed":false,"href":"/settings/automations",
        "source":"builtin","prompt":"   "}]}
        """)
        XCTAssertFalse(entries.contains(where: \.isStartable))
    }
}
