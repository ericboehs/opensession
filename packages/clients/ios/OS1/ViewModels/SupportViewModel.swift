import Foundation

/// The Plain Todo queue.
///
/// Polling only: Plain has no push into this app, and the `/ws` socket carries
/// session events, not tickets. Staleness stacks — the server caches the queue
/// for 30s under this poll — so the thread screen refetches itself rather than
/// trusting a row.
@MainActor
@Observable
final class SupportQueueModel {
    private(set) var threads: [SupportThreadSummary] = []
    private(set) var isLoading = false
    private(set) var errorText: String?

    /// Lanes, in Plain's own priority order, empty ones dropped. A flat list
    /// by time buries urgent tickets under whatever arrived last.
    var lanes: [(priority: SupportPriority, threads: [SupportThreadSummary])] {
        SupportPriority.allCases.compactMap { priority in
            let rows = threads.filter { $0.lane == priority }
            return rows.isEmpty ? nil : (priority, rows)
        }
    }

    func load() async {
        if threads.isEmpty { isLoading = true }
        do {
            threads = try await OS1API.supportThreads()
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
        isLoading = false
    }

    /// Drop a row the moment it leaves the queue, so the list doesn't hold a
    /// ticket you just finished for the length of the server's cache.
    func forget(id: String) {
        threads.removeAll { $0.id == id }
    }
}

/// One open ticket: its timeline, the composer's state, and the status
/// actions.
@MainActor
@Observable
final class SupportThreadModel {
    enum Sending: Equatable {
        case idle
        case sending
        /// How the last reply actually left: as the teammate's own Plain user,
        /// or as the workspace bot.
        case sent(asUser: Bool, wasNote: Bool)
        case failed(String)
        /// An attachment never made it to Plain, so nothing was sent and the
        /// message is still in the composer. Its own case because the advice
        /// differs: a failed send may have reached the customer anyway, a
        /// failed upload cannot have.
        case failedUpload(String)
    }

    let threadId: String
    private(set) var thread: SupportThread?
    private(set) var isLoading = true
    private(set) var errorText: String?
    private(set) var sending: Sending = .idle
    /// Set once the ticket leaves the queue from here, so the list can drop
    /// the row without waiting out the server's 30s cache.
    private(set) var statusChanged = false

    /// The composer's two modes. A note never reaches the customer; a reply is
    /// an email to a real person, which is why sending is one-shot and never
    /// retried automatically.
    var isNoteMode = false
    var draft = ""
    /// Files waiting to go with the next send. Nothing is uploaded until the
    /// send itself: an upload is stamped with the mode it was made for, so a
    /// file staged as a reply is rejected once the composer flips to a note.
    private(set) var attachments: [SupportAttachmentDraft] = []

    private var pollTask: Task<Void, Never>?

    init(threadId: String) {
        self.threadId = threadId
    }

    func load() async {
        do {
            thread = try await OS1API.supportThread(id: threadId)
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
        isLoading = false
    }

    /// The web polls this every 20s and skips while the tab is hidden; the
    /// phone equivalent is stopping when the screen goes away.
    func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                if Task.isCancelled { return }
                guard let self, sending == .idle else { continue }
                await load()
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// A message is either words, files, or both — Plain takes a reply that is
    /// nothing but a screenshot. Blocked while the staged files are over the
    /// mode's budget, so an oversized set is refused here rather than after
    /// uploading part of it.
    var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !attachments.isEmpty)
            && overBudget == nil
            && sending != .sending
    }

    /// How many more files this message can take.
    var attachmentSlots: Int {
        max(0, SupportAttachmentDraft.maxCount - attachments.count)
    }

    var attachmentBytes: Int {
        attachments.reduce(0) { $0 + $1.data.count }
    }

    /// The one-line reason the staged files don't fit the current mode, or nil
    /// when they do. Says what the other mode allows, because the split is the
    /// whole reason a set that fits a note is refused as a reply.
    var overBudget: String? {
        let limit = SupportAttachmentDraft.maxTotalBytes(isNote: isNoteMode)
        guard attachmentBytes > limit else { return nil }
        return isNoteMode
            ? "Attachments are over the 50 MB limit for a note."
            : "Attachments are over the 6 MB limit for a reply. An internal note takes 50 MB."
    }

    /// Stage picked files, refusing what the route would reject anyway. The
    /// message names the file, so a rejection is never a picker that silently
    /// dropped something.
    @discardableResult
    func stage(_ picked: [SupportAttachmentDraft]) -> String? {
        var problem: String?
        for file in picked {
            guard attachments.count < SupportAttachmentDraft.maxCount else {
                problem = "You can attach up to \(SupportAttachmentDraft.maxCount) files."
                break
            }
            guard file.data.count <= SupportAttachmentDraft.maxFileBytes else {
                problem = "\(file.fileName) is too large (25 MB max)."
                continue
            }
            attachments.append(
                SupportAttachmentDraft(
                    id: file.id,
                    fileName: uniqueFileName(file.fileName),
                    mimeType: file.mimeType,
                    data: file.data
                )
            )
        }
        if let problem { sending = .failedUpload(problem) }
        return problem
    }

    func removeAttachment(_ file: SupportAttachmentDraft) {
        attachments.removeAll { $0.id == file.id }
    }

    /// Two photos picked in the same second carry the same generated name, and
    /// so do two copies of one file from the Files app — Plain would show a
    /// pair of identical rows.
    private func uniqueFileName(_ name: String) -> String {
        guard attachments.contains(where: { $0.fileName == name }) else { return name }
        let url = URL(fileURLWithPath: name)
        let ext = url.pathExtension
        let stem = ext.isEmpty ? name : url.deletingPathExtension().lastPathComponent
        for suffix in 2...(SupportAttachmentDraft.maxCount + 1) {
            let candidate = ext.isEmpty ? "\(stem) (\(suffix))" : "\(stem) (\(suffix)).\(ext)"
            if !attachments.contains(where: { $0.fileName == candidate }) { return candidate }
        }
        return name
    }

    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !attachments.isEmpty, sending != .sending else { return }
        let wasNote = isNoteMode
        if let problem = overBudget {
            sending = .failedUpload(problem)
            return
        }
        let staged = attachments
        sending = .sending
        var attachmentIds: [String] = []
        for file in staged {
            do {
                attachmentIds.append(
                    try await OS1API.uploadSupportAttachment(
                        threadId: threadId,
                        fileName: file.fileName,
                        mimeType: file.mimeType,
                        data: file.data,
                        isNote: wasNote
                    )
                )
            } catch {
                // Nothing has been sent yet, so the message and every file
                // stay put: this is the one failure the person can simply
                // retry.
                sending = .failedUpload(
                    "\(file.fileName) didn't upload: \(error.localizedDescription)"
                )
                return
            }
        }
        do {
            let sentAs = try await OS1API.sendSupportReply(
                threadId: threadId,
                text: text,
                isNote: wasNote,
                attachmentIds: attachmentIds
            )
            draft = ""
            attachments = []
            sending = .sent(asUser: sentAs == "user", wasNote: wasNote)
            // The reply route busts no cache, but the single-thread route is
            // uncached — so the new entry is one refetch away.
            await load()
        } catch {
            // Deliberately keeps the draft: a failed send may still have
            // reached Plain, and retyping a lost reply is worse than deciding
            // for yourself whether to send it again.
            sending = .failed(error.localizedDescription)
        }
    }

    func setStatus(_ status: String, durationSeconds: Int? = nil) async {
        do {
            try await OS1API.setSupportStatus(
                threadId: threadId,
                status: status,
                durationSeconds: durationSeconds
            )
            statusChanged = true
            await load()
        } catch {
            errorText = error.localizedDescription
        }
    }
}
