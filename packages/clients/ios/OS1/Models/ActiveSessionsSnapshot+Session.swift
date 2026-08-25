import Foundation

extension ActiveSessionsSnapshot {
    static func make(
        from sessions: [Session],
        userName: String,
        githubLogin: String,
        isUnread: (Session) -> Bool = { _ in false },
        now: Date = Date()
    ) -> ActiveSessionsSnapshot {
        var identities = Set<String>()
        let displayName = userName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !displayName.isEmpty {
            identities.insert(displayName.lowercased())
            if let first = displayName.split(separator: " ").first {
                identities.insert(first.lowercased())
            }
        }
        let login = githubLogin.trimmingCharacters(in: .whitespacesAndNewlines)
        if !login.isEmpty { identities.insert(login.lowercased()) }

        let active = sessions.filter { session in
            guard session.isRunning == true,
                  session.archived != true,
                  session.desk != true,
                  !session.isAutomation
            else { return false }
            if !login.isEmpty, let ownerLogin = session.createdByLogin, !ownerLogin.isEmpty {
                return ownerLogin.caseInsensitiveCompare(login) == .orderedSame
            }
            return [session.createdBy, session.startedBy]
                .compactMap { $0?.lowercased() }
                .contains { identities.contains($0) }
        }.sorted {
            let left = $0.lastActivityDate ?? .distantPast
            let right = $1.lastActivityDate ?? .distantPast
            return left == right ? $0.id < $1.id : left > right
        }

        return ActiveSessionsSnapshot(
            sessions: active.prefix(maximumVisibleSessions).map {
                ActiveSessionSummary(
                    id: $0.id,
                    title: String($0.displayTitle.prefix(80)),
                    repo: String(
                        ($0.repoLess == true ? "No repo" : $0.effectiveRepo).prefix(40)
                    ),
                    startedAt: $0.runStartedDate?.timeIntervalSince1970
                )
            },
            totalCount: active.count,
            unreadCount: sessions.count {
                CatchUpQueue.qualifies(
                    $0,
                    viewerName: userName,
                    viewerLogin: githubLogin,
                    isUnread: isUnread
                )
            },
            updatedAt: now.timeIntervalSince1970
        )
    }
}
