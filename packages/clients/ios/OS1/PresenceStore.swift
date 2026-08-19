import Foundation
import Observation

/// Who on the team is focused on which session, app-wide. The sidebar consumes
/// this global view; the session header gets its own per-session presence frame.
///
/// This listener owns a WebSocket because the sidebar still needs updates when
/// no session is selected. It never sends `watch`, so it cannot make its owner
/// appear on a session.
@MainActor
@Observable
final class PresenceStore {
    static let shared = PresenceStore()

    private(set) var bySession: [String: [String]] = [:]

    private var socket: OS1Socket?
    private var reconnectTask: Task<Void, Never>?
    private var connectedScope: String?

    /// Everyone else focused on any session represented by a sidebar row.
    func viewers(of sessions: [Session]) -> [String] {
        guard !bySession.isEmpty else { return [] }
        var seen = Set<String>()
        var viewers: [String] = []
        for session in sessions {
            for user in bySession[session.id] ?? [] where seen.insert(user).inserted {
                viewers.append(user)
            }
        }
        return viewers
    }

    func start() {
        let config = ServerConfig.shared
        guard config.isConfigured else { return stop() }
        let scope = "\(config.baseURLString)|\(config.token)"
        if socket != nil, connectedScope == scope { return }
        stop()
        connectedScope = scope
        let socket = OS1Socket()
        socket.onEvent = { [weak self] event in
            switch event {
            case .globalPresence(let viewing):
                self?.apply(viewing)
            case .mention(let user, let mention):
                MentionStore.shared.receive(user: user, mention: mention)
            case .mentionsCleared(let user, let sessionId):
                MentionStore.shared.receiveCleared(user: user, sessionId: sessionId)
            default:
                break
            }
        }
        socket.onClose = { [weak self] _ in self?.scheduleReconnect() }
        self.socket = socket
        socket.connect()
    }

    /// Inactive/backgrounded apps stop listening and discard stale faces.
    func stop() {
        reconnectTask?.cancel()
        reconnectTask = nil
        socket?.disconnect()
        socket = nil
        connectedScope = nil
        bySession = [:]
    }

    func apply(_ viewing: [PresenceEntry]) {
        let me = ServerConfig.shared.userName
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        var next: [String: [String]] = [:]
        for entry in viewing {
            let first = entry.user.split(separator: " ").first?.lowercased() ?? ""
            guard !first.isEmpty, first != me else { continue }
            next[entry.sessionId, default: []].append(entry.user)
        }
        bySession = next
        if !next.isEmpty {
            Task { await TeamDirectory.shared.ensureLoaded() }
        }
    }

    private func scheduleReconnect() {
        guard socket != nil else { return }
        bySession = [:]
        reconnectTask?.cancel()
        let scope = connectedScope
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self, !Task.isCancelled, self.connectedScope == scope else { return }
            self.socket = nil
            self.connectedScope = nil
            self.start()
        }
    }
}
