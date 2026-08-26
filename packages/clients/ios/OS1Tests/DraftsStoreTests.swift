import XCTest
@testable import OS1

/// Unsent composer text is shared with the web client through `/api/drafts`,
/// so both clients have to agree about whose copy wins. The rule is a dirty
/// check: a session that was not typed into here follows the server, including
/// a deletion, which is what clears the pencil after the message is sent on
/// the other device.
final class DraftSyncTests: XCTestCase {
    private func remote(_ pairs: [String: String]) -> [String: RemoteDraft] {
        pairs.mapValues { RemoteDraft(text: $0, updatedAt: "2026-08-13T10:00:00.000Z") }
    }

    func testADraftTypedOnAnotherDeviceLandsHere() {
        let actions = DraftSync.reconcile(
            server: remote(["os-1": "from the browser"]),
            state: .init(local: [:], synced: [:])
        )
        XCTAssertEqual(actions, [.adopt(id: "os-1", text: "from the browser")])
    }

    func testTextTypedHereIsNeverReplaced() {
        let actions = DraftSync.reconcile(
            server: remote(["os-1": "older, from the browser"]),
            state: .init(local: ["os-1": "typing right now"], synced: [:])
        )
        XCTAssertEqual(actions, [.push(id: "os-1")])
    }

    func testADraftSentElsewhereIsClearedHere() {
        let actions = DraftSync.reconcile(
            server: [:],
            state: .init(local: ["os-1": "sent in the browser"], synced: ["os-1": "sent in the browser"])
        )
        XCTAssertEqual(actions, [.adopt(id: "os-1", text: "")])
    }

    func testADraftEditedHereSurvivesTheOtherDeviceClearingIt() {
        let actions = DraftSync.reconcile(
            server: [:],
            state: .init(local: ["os-1": "kept writing"], synced: ["os-1": "old text"])
        )
        XCTAssertEqual(actions, [.push(id: "os-1")])
    }

    func testAnUnchangedDraftIsOnlyRecordedAsAgreed() {
        let actions = DraftSync.reconcile(
            server: remote(["os-1": "same"]),
            state: .init(local: ["os-1": "same"], synced: ["os-1": "same"])
        )
        XCTAssertEqual(actions, [.agree(id: "os-1", text: "same")])
    }

    func testTextTypedBeforeTheFirstLoadIsPublished() {
        let actions = DraftSync.reconcile(
            server: [:],
            state: .init(local: ["os-1": "typed while offline"], synced: [:])
        )
        XCTAssertEqual(actions, [.push(id: "os-1")])
    }

    func testNothingToDoWhenBothSidesAreEmpty() {
        XCTAssertTrue(
            DraftSync.reconcile(server: [:], state: .init(local: [:], synced: [:])).isEmpty
        )
    }
}

@MainActor
final class DraftsStoreTests: XCTestCase {
    /// A store that records its writes instead of reaching the network.
    private func store() -> (DraftsStore, () -> [(id: String, text: String)]) {
        ServerConfig.shared.baseURLString = "https://os.example.test"
        ServerConfig.shared.token = "test-token"
        UserDefaults.standard.removeObject(forKey: "os1.composerDrafts")
        let store = DraftsStore()
        final class Box: @unchecked Sendable { var writes: [(id: String, text: String)] = [] }
        let box = Box()
        store.pushDelay = .zero
        store.push = { _, id, text, _, _ in
            box.writes.append((id: id, text: text))
            return DraftUpsert(draft: text.isEmpty ? nil : RemoteDraft(text: text, updatedAt: ""), applied: true)
        }
        return (store, { box.writes })
    }

    func testTypedTextIsHeldAndFlagsTheSession() {
        let (store, _) = self.store()
        store.setText("half a thought", for: "os-1")
        XCTAssertEqual(store.text(for: "os-1"), "half a thought")
        XCTAssertTrue(store.hasDraft("os-1"))
    }

    func testSendingClearsTheFlag() {
        let (store, _) = self.store()
        store.setText("about to send", for: "os-1")
        store.setText("", for: "os-1")
        XCTAssertNil(store.text(for: "os-1"))
        XCTAssertFalse(store.hasDraft("os-1"))
    }

    func testTypingAndSendingAreBothWrittenThrough() async {
        let (store, writes) = self.store()
        store.setText("typed", for: "os-1", immediate: true)
        store.setText("", for: "os-1")
        // The writes themselves are fire-and-forget tasks on this actor.
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(writes().map(\.text), ["typed", ""])
    }

    // A draft typed while the worktree is still being prepared belongs to the
    // session that create resolves to, not to the temporary id.
    func testADraftFollowsAPendingSessionOntoItsRealId() {
        let (store, _) = self.store()
        store.setText("typed while it was still starting", for: "temp-1")
        store.remap(tempId: "temp-1", to: "os-9")
        XCTAssertEqual(store.text(for: "os-9"), "typed while it was still starting")
        XCTAssertNil(store.text(for: "temp-1"))
        XCTAssertFalse(store.hasDraft("temp-1"))
        XCTAssertTrue(store.hasDraft("os-9"))
    }

    func testHydrateBringsInADraftFromAnotherDevice() {
        let (store, _) = self.store()
        store.apply(["os-1": RemoteDraft(text: "from the browser", updatedAt: "2026-08-13T10:00:00.000Z")])
        XCTAssertEqual(store.text(for: "os-1"), "from the browser")
        XCTAssertTrue(store.hasDraft("os-1"))
    }

    func testHydrateDoesNotOverwriteWhatIsBeingTypedHere() {
        let (store, _) = self.store()
        store.setText("typing right now", for: "os-1", immediate: true)
        store.apply(["os-1": RemoteDraft(text: "stale copy", updatedAt: "2026-08-13T09:00:00.000Z")])
        XCTAssertEqual(store.text(for: "os-1"), "typing right now")
    }

    func testHydrateClearsADraftSentOnTheOtherDevice() {
        let (store, _) = self.store()
        store.apply(["os-1": RemoteDraft(text: "from the browser", updatedAt: "2026-08-13T10:00:00.000Z")])
        store.apply([:])
        XCTAssertNil(store.text(for: "os-1"))
        XCTAssertFalse(store.hasDraft("os-1"))
    }

    func testMountedCleanComposerFollowsRemoteChanges() {
        let (store, _) = self.store()
        store.apply(["os-1": RemoteDraft(text: "from the browser", updatedAt: "2026-08-13T10:00:00.000Z")])
        XCTAssertEqual(store.mountedText(for: "os-1"), "from the browser")
        store.apply([:])
        XCTAssertEqual(store.mountedText(for: "os-1"), "")
    }

    func testMountedComposerFollowsRemoteAfterItsLocalPushWasAgreed() async {
        let (store, _) = self.store()
        store.apply(["os-1": RemoteDraft(text: "agreed", updatedAt: "2026-08-13T10:00:00.000Z")])
        store.setText("still typing", for: "os-1", immediate: true)
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(50))
        store.apply(["os-1": RemoteDraft(text: "edited elsewhere", updatedAt: "2026-08-13T10:01:00.000Z")])
        XCTAssertEqual(store.mountedText(for: "os-1"), "edited elsewhere")
    }

    func testWhitespaceOnlyTextIsNotADraft() {
        let (store, _) = self.store()
        store.setText("   \n", for: "os-1")
        XCTAssertNil(store.text(for: "os-1"))
        XCTAssertFalse(store.hasDraft("os-1"))
    }

    func testPendingDraftWaitsForTheRealSessionId() async {
        let (store, writes) = self.store()
        store.setText("still creating", for: "pending-1", immediate: true)
        await Task.yield()
        XCTAssertTrue(writes().isEmpty)
        store.remap(tempId: "pending-1", to: "os-1")
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(writes().contains { $0.id == "os-1" && $0.text == "still creating" })
    }

    func testAccountSwitchKeepsEachAccountsCachedDraftsSeparate() {
        let config = ServerConfig.shared
        let originalName = config.userName
        let originalLogin = config.githubLogin
        defer {
            config.userName = originalName
            config.githubLogin = originalLogin
            UserDefaults.standard.removeObject(forKey: "os1.composerDrafts")
        }
        UserDefaults.standard.removeObject(forKey: "os1.composerDrafts")

        config.userName = "Account A"
        config.githubLogin = "account-a"
        let store = DraftsStore()
        store.setText("A's unsent words", for: "os-a")
        store.flushAll()

        config.userName = "Account B"
        config.githubLogin = "account-b"
        store.resetForNewContext(NativePreferences.context())
        XCTAssertNil(store.text(for: "os-a"))
        store.setText("B's unsent words", for: "os-b")
        store.flushAll()

        config.userName = "Account A"
        config.githubLogin = "account-a"
        store.resetForNewContext(NativePreferences.context())
        XCTAssertEqual(store.text(for: "os-a"), "A's unsent words")
        XCTAssertNil(store.text(for: "os-b"))
    }

    func testOfflineDraftKeepsItsOriginalTimestampAcrossRelaunch() async {
        let config = ServerConfig.shared
        let originalName = config.userName
        let originalLogin = config.githubLogin
        defer {
            config.userName = originalName
            config.githubLogin = originalLogin
            UserDefaults.standard.removeObject(forKey: "os1.composerDrafts")
        }
        config.userName = "Timestamp Test"
        config.githubLogin = "timestamp-test"
        UserDefaults.standard.removeObject(forKey: "os1.composerDrafts")

        final class Box: @unchecked Sendable { var stamps: [String] = [] }
        let box = Box()
        let first = DraftsStore()
        first.push = { _, _, _, at, _ in
            box.stamps.append(at)
            return nil
        }
        first.setText("typed while offline", for: "os-1", immediate: true)
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(20))
        first.flushAll()

        let relaunched = DraftsStore()
        relaunched.push = { _, _, _, at, _ in
            box.stamps.append(at)
            return nil
        }
        relaunched.apply([:])
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(box.stamps.count, 2)
        XCTAssertEqual(box.stamps.first, box.stamps.last)
    }

    func testARowStandsForEverySessionUnderIt() throws {
        let (store, _) = self.store()
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(#"[{"id":"os-1"},{"id":"os-2"}]"#.utf8)
        )
        XCTAssertFalse(store.hasDraft(sessions))
        store.setText("typed in the second tab", for: "os-2")
        XCTAssertTrue(store.hasDraft(sessions))
    }
}
