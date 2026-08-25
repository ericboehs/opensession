import Foundation
import Observation

/// What this instance calls its agent, fetched once per launch from
/// `GET /api/settings/identity`.
///
/// The name matters wherever the app puts the agent beside a person — the
/// Review section names both reviewers, and the configured persona may read as
/// a person rather than a category. Every instance sets its own, so it cannot
/// be a constant; until the fetch lands (or on a server too old to
/// answer) the fallback is the generic word, which is never wrong.
@MainActor
@Observable
final class InstanceIdentity {
    static let shared = InstanceIdentity()

    private(set) var personaName = "Agent"
    private var accountID: String?
    private var loading = false
    private var lastFailureAt: Date?

    func ensureLoaded() async {
        let currentAccountID = ServerConfig.shared.activeId
        if accountID != currentAccountID {
            accountID = currentAccountID
            personaName = "Agent"
            loading = false
            lastFailureAt = nil
        }
        guard personaName == "Agent", !loading else { return }
        if let lastFailureAt, Date().timeIntervalSince(lastFailureAt) < 30 { return }
        loading = true
        defer {
            if accountID == currentAccountID { loading = false }
        }
        guard let identity = try? await OS1API.identity() else {
            if accountID == currentAccountID { lastFailureAt = Date() }
            return
        }
        guard accountID == currentAccountID,
              ServerConfig.shared.activeId == currentAccountID
        else { return }
        if let name = identity.personaName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty {
            personaName = name
        }
        lastFailureAt = nil
    }
}
