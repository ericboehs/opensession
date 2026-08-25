import Foundation

/// Settings → Integrations: the tools this instance is wired into.
///
/// These are the integration and GitHub sign-in halves of
/// `GET /api/setup/status`, which is also what the Setup checklist reads —
/// one decode and one set of state rules, so a row that says "Missing
/// credentials" on one screen cannot say something else on the other.
struct IntegrationEnvVar: Codable, Sendable, Equatable, Identifiable {
    var name: String
    var required: Bool?
    /// What the credential is for. `description` is spoken for on every Swift
    /// type, so the wire name is mapped rather than shadowing it.
    var detail: String?
    /// Whether the server currently holds a value. The value itself is never
    /// returned, here or anywhere: a stored credential is write-only.
    var present: Bool?

    var id: String { name }

    private enum CodingKeys: String, CodingKey {
        case name, required, present
        case detail = "description"
    }
}

struct IntegrationLink: Codable, Sendable, Equatable, Identifiable {
    var label: String?
    var url: String?

    var id: String { url ?? label ?? "" }
}

struct IntegrationSettings: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var label: String?
    var doc: String?
    var enabled: Bool?
    var env: [IntegrationEnvVar]?
    var links: [IntegrationLink]?
    var missingRequired: [String]?

    var title: String { label ?? id }
}

struct GithubSignInSettings: Codable, Sendable, Equatable {
    var userPrAuth: Bool?
    var clientIdConfigured: Bool?
    var clientSecretConfigured: Bool?
    var appCreateUrl: String?
}

/// The rules that turn a snapshot into what a row says, ported from the web's
/// `setup-shared.tsx`. The server sends facts (`enabled`, `missingRequired`)
/// and leaves the wording to each client, so this is the one place either
/// screen decides it.
enum IntegrationRules {
    /// One line per integration saying what it brings, so a row is not just a
    /// brand name. Same text as the web's `INTEGRATION_DESCRIPTIONS`.
    static let descriptions: [String: String] = [
        "plain": "Support threads, internal notes, and triage webhooks.",
        "linear": "Assigned issues become scoped coding sessions.",
        "slack": "DMs, mentions, session channels, and interactive controls.",
        "stripe": "Dispute webhooks routed into scoped automations.",
        "grafana": "Loki failure signatures routed into investigation automations.",
        "github": "PR comments, reviews, webhooks, and bot-authored work.",
        "codestorage": "Git hosting with branch-based reviews and local signing keys.",
    ]

    static func description(_ integration: IntegrationSettings) -> String {
        descriptions[integration.id] ?? "Connect \(integration.title)."
    }

    static func state(_ integration: IntegrationSettings) -> (tone: SetupTone, label: String) {
        let enabled = integration.enabled ?? false
        let missing = integration.missingRequired ?? []
        if enabled && missing.isEmpty { return (.on, "On") }
        if enabled { return (.warn, "Missing credentials") }
        return (.off, "Off")
    }

    /// Whether the switch is offered at all.
    ///
    /// Turning something ON that has no credentials only produces an
    /// integration that reports itself broken, so the switch appears once the
    /// credentials are in — or, for anything already on, so it can be turned
    /// back off. Code storage is excluded outright: it is switched by
    /// connecting a host, not by a flag.
    static func canToggle(_ integration: IntegrationSettings) -> Bool {
        guard integration.id != "codestorage" else { return false }
        return (integration.enabled ?? false) || (integration.missingRequired ?? []).isEmpty
    }

    static func githubState(_ github: GithubSignInSettings) -> (tone: SetupTone, label: String) {
        let userPrAuth = github.userPrAuth ?? false
        if userPrAuth && (github.clientIdConfigured ?? false) { return (.on, "Active") }
        if userPrAuth { return (.warn, "Missing client id") }
        return (.off, "Off")
    }

    /// What GitHub sign-in is doing for people right now, in one sentence.
    ///
    /// Signing in is a device code and needs no client secret, but renewing a
    /// token does, so an instance without one signs people in and then drops
    /// them a few hours later. That is worth saying on the row.
    static func githubDetail(_ github: GithubSignInSettings) -> String {
        guard (github.userPrAuth ?? false) && (github.clientIdConfigured ?? false) else {
            return "Off, so sessions open pull requests from the workspace account."
        }
        return (github.clientSecretConfigured ?? false)
            ? "Teammates sign in with GitHub and open pull requests as themselves."
            : "Teammates sign in with GitHub. Add a client secret so their tokens renew."
    }
}

struct IntegrationUpdateResponse: Codable, Sendable {
    var integration: IntegrationSettings?
    /// Credentials and enable flags are read once at boot, so a change is
    /// stored now and in force after a restart. The server says so on every
    /// write today; it is decoded rather than assumed so one that learns to
    /// apply a change live can say that instead.
    var restartRequired: Bool?
}

struct GithubSignInResponse: Codable, Sendable {
    var github: GithubSignInSettings?
    var restartRequired: Bool?
}
