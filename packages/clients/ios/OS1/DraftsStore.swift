import Foundation
import Observation

/// One session's unsent text as the server holds it (src/server/drafts.ts).
struct RemoteDraft: Codable, Sendable, Equatable {
    var text: String
    var updatedAt: String
}

/// The answer to a draft write: `applied` is false when the server already
/// held a newer copy, which comes back in `draft`.
struct DraftUpsert: Codable, Sendable {
    var draft: RemoteDraft?
    var applied: Bool
}

/// The rule for reconciling this device's drafts with the server's, kept
/// separate from the store so it can be read and tested on its own. The web
/// client runs the same rule (src/frontend/lib/drafts-sync.ts).
///
/// It is a dirty check, not a timestamp race: a session whose text still
/// equals what we last agreed with the server was not typed into here, so the
/// server copy wins, including a deletion. That deletion is the half that
/// matters most, because it is what takes the pencil off the row here after
/// you send the message in the browser.
enum DraftSync {
    struct State: Equatable {
        /// Session id → the text held here right now.
        var local: [String: String]
        /// Session id → the text last agreed with the server.
        var synced: [String: String]
    }

    enum Action: Equatable {
        /// Replace the local text with the server's (may be empty).
        case adopt(id: String, text: String)
        /// Already equal; record it as agreed.
        case agree(id: String, text: String)
        /// Typed here since the last agreement: send it.
        case push(id: String)
    }

    static func reconcile(server: [String: RemoteDraft], state: State) -> [Action] {
        var actions: [Action] = []
        func isDirty(_ id: String) -> Bool {
            (state.local[id] ?? "") != (state.synced[id] ?? "")
        }

        for (id, entry) in server where !isDirty(id) {
            if (state.local[id] ?? "") == entry.text {
                actions.append(.agree(id: id, text: entry.text))
            } else {
                actions.append(.adopt(id: id, text: entry.text))
            }
        }
        // Agreed drafts the server no longer holds were sent or cleared on the
        // other device.
        for id in state.synced.keys where server[id] == nil && !isDirty(id) {
            if !(state.local[id] ?? "").isEmpty {
                actions.append(.adopt(id: id, text: ""))
            }
        }
        // Everything typed here the server hasn't agreed to yet, including
        // text entered before the first hydrate landed.
        for id in state.local.keys where isDirty(id) {
            actions.append(.push(id: id))
        }
        return actions
    }
}

/// Unsent composer text, per session, kept on the server so it survives the
/// app being killed and follows you between the phone and the browser.
///
/// Only text travels. Staged images stay with the device that staged them
/// (`SessionViewModel.ComposerDraft` still carries those in memory).
///
/// Observation note: `sessionsWithDrafts` is the only observable property, and
/// it changes when a draft appears or disappears, never per keystroke. The
/// text itself is deliberately not observable, so a session list showing the
/// pencil doesn't re-render while someone types.
@Observable
@MainActor
final class DraftsStore {
    static let shared = DraftsStore()

    private struct CacheBucket: Codable {
        var texts: [String: String]
        var synced: [String: String]
        var editedAt: [String: String]?
    }

    private static let cacheKey = "os1.composerDrafts"

    /// Sessions holding unsent text. What the list row's pencil reads.
    private(set) var sessionsWithDrafts: Set<String> = []
    /// Changes only when hydration adopts remote text, so mounted composers
    /// can follow another device without observing local keystrokes.
    private(set) var remoteRevision = 0

    @ObservationIgnored private var texts: [String: String] = [:]
    @ObservationIgnored private var syncedText: [String: String] = [:]
    /// The text of the last write started for a session, confirmed or not.
    @ObservationIgnored private var attemptedText: [String: String] = [:]
    @ObservationIgnored private var editedAt: [String: String] = [:]
    @ObservationIgnored private var pushTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var writeTasks: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var hydratedContext: NativePreferences.Context?
    @ObservationIgnored private var hasHydrated = false
    @ObservationIgnored private var hydrateRetryTask: Task<Void, Never>?
    @ObservationIgnored private var persistTask: Task<Void, Never>?

    /// Long enough that a burst of typing is one write, short enough that the
    /// draft is on the server before someone locks the phone mid-sentence.
    @ObservationIgnored var pushDelay: Duration = .milliseconds(800)

    /// How long a failed load waits before trying again. The web client uses
    /// the same 5s (src/frontend/lib/drafts.ts).
    @ObservationIgnored var hydrateRetryDelay: Duration = .seconds(5)

    /// Seam for tests: the network call the store makes.
    @ObservationIgnored
    var push: (
        _ user: String,
        _ id: String,
        _ text: String,
        _ at: String,
        _ connection: SettingsAPI.Connection
    ) async -> DraftUpsert? = { user, id, text, at, connection in
        try? await SettingsAPI.saveDraft(
            user: user,
            sessionId: id,
            text: text,
            updatedAt: at,
            connection: connection
        )
    }

    init() {
        let context = NativePreferences.context()
        hydratedContext = context
        restore(context)
    }

    /// The text held for a session, if any. Used to seed a composer.
    func text(for sessionId: String) -> String? {
        let text = texts[sessionId] ?? ""
        return text.isEmpty ? nil : text
    }

    func hasDraft(_ sessionId: String) -> Bool {
        sessionsWithDrafts.contains(sessionId)
    }

    /// A row stands for every session under it, like the unread mark.
    func hasDraft(_ sessions: [Session]) -> Bool {
        sessions.contains { sessionsWithDrafts.contains($0.id) }
    }

    /// Text the store decided belongs in a mounted composer after hydration.
    /// Dirty local text is already in `texts`, because each keystroke calls
    /// `setText`; clean text was replaced by reconciliation.
    func mountedText(for sessionId: String) -> String {
        return texts[sessionId] ?? ""
    }

    /// The composer's text changed. Called on every keystroke, so the write is
    /// debounced; sending (which empties the draft) pushes straight away, since
    /// that is what clears the pencil on the other device.
    func setText(_ text: String, for sessionId: String, immediate: Bool = false) {
        let stored = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : text
        guard (texts[sessionId] ?? "") != stored else { return }
        texts[sessionId] = stored
        editedAt[sessionId] = ISO8601DateFormatter.draftStamp.string(from: Date())
        updatePresence(sessionId)
        schedulePersist()
        pushTasks[sessionId]?.cancel()
        if sessionId.hasPrefix("pending-") { return }
        if immediate || stored.isEmpty {
            pushTasks[sessionId] = nil
            send(sessionId)
            return
        }
        let delay = pushDelay
        pushTasks[sessionId] = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            self.pushTasks[sessionId] = nil
            self.send(sessionId)
        }
    }

    /// Push whatever is pending for a session now (leaving the conversation).
    func flush(_ sessionId: String) {
        guard pushTasks[sessionId] != nil else { return }
        pushTasks[sessionId]?.cancel()
        pushTasks[sessionId] = nil
        send(sessionId)
    }

    /// A pending session got its real id from the server: carry its draft over
    /// so the text typed while the worktree was being prepared isn't orphaned
    /// under an id nothing will ask for again.
    func remap(tempId: String, to realId: String) {
        guard tempId != realId, let text = texts.removeValue(forKey: tempId) else { return }
        syncedText.removeValue(forKey: tempId)
        attemptedText.removeValue(forKey: tempId)
        let at = editedAt.removeValue(forKey: tempId)
        pushTasks.removeValue(forKey: tempId)?.cancel()
        sessionsWithDrafts.remove(tempId)
        texts[realId] = text
        editedAt[realId] = at ?? ISO8601DateFormatter.draftStamp.string(from: Date())
        updatePresence(realId)
        schedulePersist()
        send(realId)
    }

    /// Load this user's drafts. Guarded like `ReadsStore.hydrate`: a response
    /// for a server or user we have since left is dropped.
    func hydrate() async {
        let requestContext = NativePreferences.context()
        resetForNewContext(requestContext)
        guard let server = try? await SettingsAPI.drafts(user: requestContext.user) else {
            // A dropped load used to wait for the next turn of the app's poll
            // loop, which is 30s plus five other hydrates away — long enough
            // to sit reading another device's stale draft. Try again sooner,
            // like the web client does.
            scheduleHydrateRetry(requestContext)
            return
        }
        guard NativePreferences.context() == requestContext else { return }
        hydrateRetryTask?.cancel()
        hydrateRetryTask = nil
        apply(server)
    }

    private func scheduleHydrateRetry(_ context: NativePreferences.Context) {
        hydrateRetryTask?.cancel()
        let delay = hydrateRetryDelay
        hydrateRetryTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            self.hydrateRetryTask = nil
            // Nothing to catch up on if someone else got there first, and
            // nothing to fetch for a person who has since signed out.
            guard !self.hasHydrated, NativePreferences.context() == context else { return }
            await self.hydrate()
        }
    }

    /// Kept internal so the merge contract can be tested without a server.
    func apply(_ server: [String: RemoteDraft]) {
        hasHydrated = true
        let pendingIds = server.keys.filter { $0.hasPrefix("pending-") }
        for id in pendingIds { deleteRemote(id) }
        let visibleServer = server.filter { !$0.key.hasPrefix("pending-") }
        let state = DraftSync.State(local: texts, synced: syncedText)
        for action in DraftSync.reconcile(server: visibleServer, state: state) {
            switch action {
            case .adopt(let id, let text):
                let changed = (texts[id] ?? "") != text
                texts[id] = text
                syncedText[id] = text
                attemptedText[id] = nil
                editedAt[id] = nil
                updatePresence(id)
                if changed { remoteRevision &+= 1 }
            case .agree(let id, let text):
                syncedText[id] = text
                attemptedText[id] = nil
            case .push(let id):
                send(id)
            }
        }
        // Stop tracking sessions neither side holds anything for.
        for id in syncedText.keys where visibleServer[id] == nil && (texts[id] ?? "").isEmpty {
            syncedText[id] = nil
            attemptedText[id] = nil
            texts[id] = nil
        }
        schedulePersist()
    }

    func resetForNewContext(_ context: NativePreferences.Context) {
        guard let hydratedContext else {
            self.hydratedContext = context
            return
        }
        guard hydratedContext != context else { return }
        // A different person (or server) is signed in now. Their drafts are
        // not this one's to show, and ours are already on the old server.
        for task in pushTasks.values { task.cancel() }
        for task in writeTasks.values { task.cancel() }
        hydrateRetryTask?.cancel()
        hydrateRetryTask = nil
        // Save the outgoing account under its own identity before changing
        // which bucket `persistNow` targets.
        persistNow()
        self.hydratedContext = context
        persistTask?.cancel()
        persistTask = nil
        pushTasks.removeAll()
        writeTasks.removeAll()
        texts.removeAll()
        syncedText.removeAll()
        attemptedText.removeAll()
        editedAt.removeAll()
        hasHydrated = false
        if !sessionsWithDrafts.isEmpty { sessionsWithDrafts = [] }
        restore(context)
    }

    private func updatePresence(_ sessionId: String) {
        let has = !(texts[sessionId] ?? "").isEmpty
        if has { sessionsWithDrafts.insert(sessionId) } else { sessionsWithDrafts.remove(sessionId) }
    }

    private func send(_ sessionId: String) {
        guard !sessionId.hasPrefix("pending-") else { return }
        let text = texts[sessionId] ?? ""
        // Nothing new to say. Compare against what is already ON ITS WAY, not
        // only what the server has confirmed: type a line and send it straight
        // away and the confirmation for the text is still in flight when the
        // delete is queued, which used to swallow the delete and leave the
        // draft standing on the other device.
        guard text != (attemptedText[sessionId] ?? syncedText[sessionId] ?? "") else { return }
        attemptedText[sessionId] = text
        let context = NativePreferences.context()
        guard let connection = SettingsAPI.Connection.current() else {
            attemptedText[sessionId] = syncedText[sessionId]
            return
        }
        let user = context.user
        let at = editedAt[sessionId] ?? ISO8601DateFormatter.draftStamp.string(from: Date())
        let writeId = UUID()
        let task = Task { [weak self] in
            defer { self?.writeTasks[writeId] = nil }
            let result = await self?.push(user, sessionId, text, at, connection)
            guard let self else { return }
            guard NativePreferences.context() == context else { return }
            guard let result else {
                // The write never landed. Forget the attempt so the next edit
                // (or the next hydrate) tries again instead of reading as
                // already sent.
                if self.attemptedText[sessionId] == text {
                    self.attemptedText[sessionId] = self.syncedText[sessionId]
                }
                return
            }
            // Refused as older than the stored copy: leave this session dirty
            // rather than pulling the server's text out from under a cursor.
            // The next keystroke carries a newer stamp and wins.
            guard result.applied else {
                if self.attemptedText[sessionId] == text {
                    self.attemptedText[sessionId] = self.syncedText[sessionId]
                }
                return
            }
            // Someone kept typing while this was in flight; that newer text
            // has its own push and owns the agreement.
            guard (self.texts[sessionId] ?? "") == text else { return }
            self.syncedText[sessionId] = text.isEmpty ? nil : text
        }
        writeTasks[writeId] = task
    }

    /// Persist immediately and publish every debounced write before iOS can
    /// suspend the process in the background.
    func flushAll() {
        persistTask?.cancel()
        persistTask = nil
        persistNow()
        for id in Array(pushTasks.keys) { flush(id) }
    }

    private func deleteRemote(_ sessionId: String) {
        let context = NativePreferences.context()
        guard let connection = SettingsAPI.Connection.current() else { return }
        let writeId = UUID()
        let at = ISO8601DateFormatter.draftStamp.string(from: Date())
        let task = Task { [weak self] in
            defer { self?.writeTasks[writeId] = nil }
            _ = await self?.push(context.user, sessionId, "", at, connection)
        }
        writeTasks[writeId] = task
    }

    private func cacheIdentity(_ context: NativePreferences.Context) -> String {
        "\(context.server)\u{0}\(context.user)\u{0}\(context.login)"
    }

    private func cache() -> [String: CacheBucket] {
        guard let data = UserDefaults.standard.data(forKey: Self.cacheKey),
              let value = try? JSONDecoder().decode([String: CacheBucket].self, from: data)
        else { return [:] }
        return value
    }

    private func restore(_ context: NativePreferences.Context) {
        let bucket = cache()[cacheIdentity(context)]
        texts = bucket?.texts ?? [:]
        syncedText = bucket?.synced ?? [:]
        editedAt = bucket?.editedAt ?? [:]
        sessionsWithDrafts = Set(texts.compactMap { $0.value.isEmpty ? nil : $0.key })
    }

    private func schedulePersist() {
        persistTask?.cancel()
        persistTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            self?.persistTask = nil
            self?.persistNow()
        }
    }

    private func persistNow() {
        guard let context = hydratedContext else { return }
        var buckets = cache()
        let local = texts.filter { !$0.value.isEmpty }
        if local.isEmpty && syncedText.isEmpty {
            buckets[cacheIdentity(context)] = nil
        } else {
            buckets[cacheIdentity(context)] = CacheBucket(
                texts: local,
                synced: syncedText,
                editedAt: editedAt
            )
        }
        if let data = try? JSONEncoder().encode(buckets) {
            UserDefaults.standard.set(data, forKey: Self.cacheKey)
        }
    }

}

extension ISO8601DateFormatter {
    /// Milliseconds included: the server compares these stamps to decide which
    /// device typed last, and drafts change far faster than once a second.
    static let draftStamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
