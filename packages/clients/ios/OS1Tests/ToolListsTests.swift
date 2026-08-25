import XCTest
@testable import OS1

final class ToolListsTests: XCTestCase {
    func testFeedRowsCombineMergedPullRequestsAndCommitsNewestFirst() {
        let merged = RecentPr(
            repo: "ios",
            branch: "feed",
            url: "https://example.com/1",
            number: 41,
            title: "Add Feed",
            author: "kent",
            person: "Kent",
            updatedAt: "2026-08-20T09:00:00.000Z",
            state: "MERGED",
            additions: 20,
            deletions: 2
        )
        let open = RecentPr(
            repo: "ios",
            branch: "tasks",
            url: "https://example.com/2",
            number: 42,
            title: "Add Tasks",
            author: "kent",
            person: "Kent",
            updatedAt: "2026-08-20T10:00:00.000Z",
            state: "OPEN",
            additions: 10,
            deletions: 1
        )
        let commit = RecentCommit(
            repo: "opensession",
            sha: "0123456789abcdef",
            title: "Ship native tools",
            url: nil,
            author: "OS",
            person: nil,
            committedAt: "2026-08-20T11:00:00.000Z",
            additions: 8,
            deletions: 0,
            sessionId: "os-tool-session"
        )

        let rows = FeedRows.build(prs: [merged, open], commits: [commit])

        XCTAssertEqual(rows.map(\.title), ["Ship native tools", "Add Feed"])
        XCTAssertEqual(rows.map(\.ref), ["0123456", "#41"])
        XCTAssertEqual(rows.first?.owner, "OS")
        XCTAssertEqual(rows.first?.sessionId, "os-tool-session")
    }

    func testTodoDecodesWhenOptionalContextIsAbsent() throws {
        let data = Data(
            #"{"todos":[{"id":"todo-1","user":"Kent","text":"Check Feed","status":"open","createdAt":"2026-08-20T09:00:00.000Z","updatedAt":"2026-08-20T09:00:00.000Z","source":{"kind":"manual"}}]}"#.utf8
        )

        let response = try JSONDecoder().decode(TodoListResponse.self, from: data)

        XCTAssertEqual(response.todos.count, 1)
        XCTAssertEqual(response.todos.first?.status, .open)
        XCTAssertNil(response.todos.first?.note)
        XCTAssertNil(response.todos.first?.source.sessionId)
    }
}
