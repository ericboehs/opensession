import Foundation
import Observation

/// What this instance calls its agent, fetched once per launch from
/// `GET /api/settings/identity`.
///
/// The name matters wherever the app puts the agent beside a person — the
/// Review section names both reviewers, and "Agent · 4/5" reads as a category
/// where "Michael · 4/5" reads as somebody. Every instance sets its own, so it
/// cannot be a constant; until the fetch lands (or on a server too old to
/// answer) the fallback is the generic word, which is never wrong.
@MainActor
@Observable
final class InstanceIdentity {
    static let shared = InstanceIdentity()

    private(set) var personaName = "Agent"
    private var loading = false
    private var lastFailureAt: Date?

    func ensureLoaded() async {
        guard personaName == "Agent", !loading else { return }
        if let lastFailureAt, Date().timeIntervalSince(lastFailureAt) < 30 { return }
        loading = true
        defer { loading = false }
        guard let identity = try? await OS1API.identity() else {
            lastFailureAt = Date()
            return
        }
        if let name = identity.personaName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty {
            personaName = name
        }
        lastFailureAt = nil
    }
}
