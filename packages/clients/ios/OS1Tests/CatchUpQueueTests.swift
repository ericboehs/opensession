import XCTest
@testable import OS1

/// What belongs in the catch-up deck, and in what order.
///
/// These are the rules a screenshot can't check: every one of them is a session
/// that should NOT have been put in front of you (someone else's work, an
/// automation's own run, the Desk, something already read) or an ordering that
/// would send you through your inbox backwards.
final class CatchUpQueueTests: XCTestCase {
    private func session(
        _ id: String,
        startedBy: String? = "Kent",
        workspace: String? = nil,
        title: String = "A piece of work",
        lastActivity: String = "2026-08-10T10:00:00.000Z",
        createdAt: String = "2026-08-10T09:00:00.000Z"
    ) -> Session {
        var session = Session(id: id)
        session.title = title
        session.repo = "opensession"
        session.startedBy = startedBy
        session.workspaceId = workspace
        session.createdAt = createdAt
        session.lastActivity = lastActivity
        return session
    }

    private func build(
        _ sessions: [Session],
        names: [String: String] = [:],
        unread: Set<String>,
        viewer: String = "Kent",
        login: String = "kentdebruin"
    ) -> [CatchUpCard] {
        CatchUpQueue.build(
            sessions: sessions,
            workspaceNames: names,
            viewerName: viewer,
            viewerLogin: login,
            isUnread: { unread.contains($0.id) }
        )
    }

    /// The four exclusions, each of which would otherwise hand someone a card
    /// they can't or shouldn't act on.
    func testOnlyYourOwnUnreadWorkMakesTheDeck() {
        var archived = session("archived")
        archived.archived = true
        var automation = session("automation")
        automation.startedBy = "triage (automation)"
        var desk = session("desk")
        desk.desk = true
        let teammate = session("teammate", startedBy: "Michiel")
        let read = session("read")
        let mine = session("mine")

        let cards = build(
            [archived, automation, desk, teammate, read, mine],
            unread: ["archived", "automation", "desk", "teammate", "mine"]
        )

        XCTAssertEqual(cards.map(\.target.id), ["mine"])
    }

    func testSpawnedWorkerDoesNotMakeItsParentWorkspaceUnread() {
        let parent = session("parent", workspace: "ws-1")
        var worker = session("worker", workspace: "ws-1")
        worker.spawnedBy = parent.id

        let cards = build([parent, worker], unread: ["worker"])

        XCTAssertTrue(cards.isEmpty)
    }

    /// A session you have never opened is not unread — `isUnread` is the
    /// store's judgement, and the queue must not second-guess it.
    func testNothingIsUnreadWithoutAMark() {
        XCTAssertTrue(build([session("a"), session("b")], unread: []).isEmpty)
    }

    /// One card per workspace, showing its main chat even when another chat has
    /// the newest unread activity.
    func testAWorkspaceCollapsesToOneCardShowingItsMainChat() {
        let old = session(
            "old", workspace: "ws-1",
            lastActivity: "2026-08-10T09:30:00.000Z",
            createdAt: "2026-08-10T09:00:00.000Z"
        )
        let fresh = session(
            "fresh", workspace: "ws-1",
            lastActivity: "2026-08-10T11:00:00.000Z",
            createdAt: "2026-08-10T09:15:00.000Z"
        )

        let cards = build(
            [old, fresh],
            names: ["ws-1": "Catch up on iOS"],
            unread: ["old", "fresh"]
        )

        XCTAssertEqual(cards.count, 1)
        XCTAssertEqual(cards[0].title, "Catch up on iOS")
        XCTAssertEqual(cards[0].sessionCount, 2)
        XCTAssertEqual(cards[0].target.id, "old")
    }

    /// A secondary unread chat puts the workspace in Catch Up, but it does not
    /// replace the main chat as the preview, open, or reply destination.
    func testUnreadSecondaryChatStillShowsReadMainChat() {
        let main = session(
            "main", workspace: "ws-1",
            lastActivity: "2026-08-10T09:30:00.000Z",
            createdAt: "2026-08-10T09:00:00.000Z"
        )
        let secondary = session(
            "secondary", workspace: "ws-1",
            lastActivity: "2026-08-10T11:00:00.000Z",
            createdAt: "2026-08-10T09:15:00.000Z"
        )

        let cards = build([main, secondary], unread: ["secondary"])

        XCTAssertEqual(cards.count, 1)
        XCTAssertEqual(cards[0].target.id, "main")
        XCTAssertEqual(cards[0].sessions.map(\.id), ["secondary"])
    }

    /// Newest first. An inbox you work top-down should hand you what moved most
    /// recently, not whatever order the list happened to arrive in.
    func testCardsRunNewestFirst() {
        let stale = session(
            "stale", workspace: "ws-stale",
            lastActivity: "2026-08-08T10:00:00.000Z"
        )
        let recent = session(
            "recent", workspace: "ws-recent",
            lastActivity: "2026-08-10T12:00:00.000Z"
        )
        let middle = session(
            "middle", workspace: "ws-middle",
            lastActivity: "2026-08-09T12:00:00.000Z"
        )

        let cards = build(
            [stale, recent, middle], unread: ["stale", "recent", "middle"]
        )

        XCTAssertEqual(cards.map(\.target.id), ["recent", "middle", "stale"])
    }

    /// One person arrives as several names. The deck has to credit them all to
    /// the same viewer or a teammate's sessions leak in — or, worse, your own
    /// stop showing up at all.
    func testOwnershipMatchesTheViewersOtherNames() {
        let byFullName = session("full", startedBy: "Kent de Bruin", workspace: "a")
        let byLogin = session("login", startedBy: "kentdebruin", workspace: "b")
        let byFirstName = session("first", startedBy: "Kent", workspace: "c")

        let cards = build(
            [byFullName, byLogin, byFirstName],
            unread: ["full", "login", "first"]
        )

        XCTAssertEqual(cards.count, 3)
    }

    /// The band's count and the deck's length are the same number, computed two
    /// different ways — the band counts rows to stay off the list's hot path.
    func testBandCountAgreesWithTheDeck() {
        let sessions = [
            session("a", workspace: "ws-1"),
            session("b", workspace: "ws-1"),
            session("c", workspace: "ws-2"),
            session("d", startedBy: "Michiel", workspace: "ws-3"),
        ]
        let unread: Set<String> = ["a", "b", "c", "d"]
        let rows = SessionsListViewModel.sidebarWorkspaces(
            in: sessions, workspaceNames: [:]
        )

        let counted = CatchUpQueue.unreadRowCount(
            in: rows,
            viewerName: "Kent",
            viewerLogin: "kentdebruin",
            isUnread: { unread.contains($0.id) }
        )

        XCTAssertEqual(counted, build(sessions, unread: unread).count)
        XCTAssertEqual(counted, 2)
    }
}

/// The deck's own rules, once the queue is frozen: what the repo filter hides,
/// what a decision removes, and what undo puts back.
///
/// Decisions are made with `.keep` throughout. It moves the deck exactly like
/// the other two, and it is the one that touches nothing outside the model.
/// `.read` writes to the real `ReadsStore`, which is the person's own read
/// marks on whichever machine runs the suite.
@MainActor
final class CatchUpDeckTests: XCTestCase {
    private func card(_ id: String, repo: String) -> CatchUpCard {
        CatchUpCard(
            id: id,
            title: id,
            repo: repo,
            sessions: [Session(id: id)],
            target: Session(id: id),
            lane: .inReview,
            isRunning: false,
            runStartedAt: nil,
            lastActivity: Date(timeIntervalSince1970: 0)
        )
    }

    /// Two repos interleaved, which is what makes the filter worth having.
    private func loaded() -> CatchUpViewModel {
        let model = CatchUpViewModel()
        model.load([
            card("a1", repo: "tella-fusion"),
            card("b1", repo: "opensession"),
            card("a2", repo: "tella-fusion"),
            card("b2", repo: "opensession"),
        ])
        return model
    }

    func testFilterNarrowsTheDeckToOneRepo() {
        let model = loaded()
        XCTAssertEqual(model.deck.map(\.id), ["a1", "b1", "a2", "b2"])

        model.setRepoFilter("tella-fusion")

        XCTAssertEqual(model.deck.map(\.id), ["a1", "a2"])
        XCTAssertEqual(model.remaining, 2)
        XCTAssertEqual(model.current?.id, "a1")
        XCTAssertEqual(model.next?.id, "a2")
    }

    func testWideningRestoresTheRestOfTheQueueInItsOriginalOrder() {
        let model = loaded()
        model.setRepoFilter("opensession")
        model.setRepoFilter(nil)

        XCTAssertEqual(model.deck.map(\.id), ["a1", "b1", "a2", "b2"])
    }

    /// The point of filtering the frozen queue rather than rebuilding it: work
    /// done under one filter is still done under the next.
    func testDecisionsSurviveAFilterChange() {
        let model = loaded()
        model.setRepoFilter("tella-fusion")
        model.act(.keep)
        XCTAssertEqual(model.deck.map(\.id), ["a2"])

        model.setRepoFilter(nil)

        XCTAssertEqual(model.deck.map(\.id), ["b1", "a2", "b2"])
    }

    /// Undo returns a card to where it was, not to the end of the queue.
    func testUndoPutsACardBackInItsOriginalPlace() {
        let model = loaded()
        model.act(.keep)
        XCTAssertEqual(model.deck.map(\.id), ["b1", "a2", "b2"])

        model.undo()

        XCTAssertEqual(model.deck.map(\.id), ["a1", "b1", "a2", "b2"])
        XCTAssertEqual(model.handled, 0)
    }

    /// A filter change is a change of subject, so the undo it was offering
    /// goes with it. A button that would put a card back somewhere you are no
    /// longer looking does nothing you can see.
    func testChangingTheFilterDropsThePendingUndo() {
        let model = loaded()
        model.act(.keep)
        XCTAssertNotNil(model.undoable)

        model.setRepoFilter("opensession")

        XCTAssertNil(model.undoable)
    }

    /// The menu is built from the queue the deck started with, so a repo holds
    /// its place while you empty it instead of vanishing under your finger.
    func testRepoOptionsHoldTheirPlaceAndCountWhatIsLeft() {
        let model = loaded()
        XCTAssertEqual(model.repoOptions.map(\.repo), ["tella-fusion", "opensession"])
        XCTAssertEqual(model.repoOptions.map(\.remaining), [2, 2])

        model.setRepoFilter("tella-fusion")
        model.act(.keep)
        model.act(.keep)

        XCTAssertEqual(model.repoOptions.map(\.repo), ["tella-fusion", "opensession"])
        XCTAssertEqual(model.repoOptions.map(\.remaining), [0, 2])
    }

    /// Clearing the repo you narrowed to finishes THAT repo. Saying "all caught
    /// up" here would send you away from work you only meant to set aside.
    func testClearingAFilteredRepoIsNotBeingCaughtUp() {
        let model = loaded()
        model.setRepoFilter("tella-fusion")
        model.act(.keep)
        model.act(.keep)

        XCTAssertTrue(model.isDone)
        XCTAssertFalse(model.isEmpty)
        XCTAssertEqual(model.remainingElsewhere, 2)

        model.setRepoFilter(nil)

        XCTAssertFalse(model.isDone)
        XCTAssertEqual(model.deck.map(\.id), ["b1", "b2"])
        XCTAssertEqual(model.remainingElsewhere, 0)
    }

    /// The progress bar's denominator follows the filter; without that it would
    /// sit still while you cleared everything in front of you.
    func testScopeTotalFollowsTheFilter() {
        let model = loaded()
        XCTAssertEqual(model.scopeTotal, 4)

        model.setRepoFilter("opensession")

        XCTAssertEqual(model.scopeTotal, 2)
    }
}

@MainActor
final class CatchUpConversationTests: XCTestCase {
    private func entry(_ id: String, _ type: String, _ content: String) -> TranscriptEntry {
        let object: [String: Any] = ["id": id, "type": type, "content": content]
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(TranscriptEntry.self, from: data)
    }

    /// Catch Up renders the normal transcript instead of reducing it to an
    /// opening prompt and latest answer.
    func testConversationKeepsEveryMessage() {
        let conversation = CatchUpViewModel.conversation(
            from: [
                entry("prompt", "user", "First question"),
                entry("answer-1", "assistant", "First answer"),
                entry("follow-up", "user", "Follow-up question"),
                entry("answer-2", "assistant", "Second answer"),
            ],
            session: Session(id: "main")
        )

        XCTAssertEqual(
            conversation.blocks.map(\.id),
            ["prompt", "answer-1", "follow-up", "answer-2"]
        )
        XCTAssertFalse(conversation.failed)
    }
}
