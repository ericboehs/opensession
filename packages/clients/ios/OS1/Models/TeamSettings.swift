import Foundation

/// Settings → Members: the identity table.
///
/// Commit attribution, MCP `allowedUsers` scoping and GitHub sign-in all
/// resolve a session's user through this one roster, so a member carries
/// every identifier they might arrive under rather than only the name they
/// are shown as (src/server/routes/setup-team.ts).
struct TeamMemberSettings: Codable, Sendable, Identifiable, Equatable {
    var name: String
    var email: String?
    var github: String?
    var slackId: String?
    var aliases: [String]?

    /// The roster is keyed by name, case-insensitively, and that key is also
    /// the path segment an edit or a removal is addressed to.
    var id: String { name.lowercased() }

    /// What the row says under the name: the two identifiers a person
    /// recognises themselves by, in the order the web lists them. The Slack
    /// id and aliases are left to the editor, where they can be read in full.
    var identifierSummary: String {
        var parts: [String] = []
        if let email, !email.isEmpty { parts.append(email) }
        if let github, !github.isEmpty { parts.append("@\(github)") }
        return parts.joined(separator: " · ")
    }
}

struct TeamMembersResponse: Codable, Sendable {
    var members: [TeamMemberSettings]?
}

/// One field of a member edit, as the server's partial-update body spells it.
enum TeamMemberField: Equatable {
    case text(String)
    case aliases([String])
    /// A field that was set and has been emptied. The server deletes the key
    /// when its value is null, so "cleared" and "unchanged" cannot both be
    /// left out of the body.
    case cleared
}

/// What a member form holds while it is being filled in.
struct TeamMemberDraft: Equatable {
    var name = ""
    var email = ""
    var github = ""
    var slackId = ""
    /// Free text, comma separated — an alias list is short and reads better
    /// as one line than as a list editor on a phone.
    var aliasText = ""

    init() {}

    init(_ member: TeamMemberSettings) {
        name = member.name
        email = member.email ?? ""
        github = member.github ?? ""
        slackId = member.slackId ?? ""
        aliasText = (member.aliases ?? []).joined(separator: ", ")
    }

    var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }

    var aliases: [String] {
        aliasText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}

/// Turning a filled-in form into a request body.
///
/// An edit sends only what changed. Sending the whole form instead would
/// rewrite fields nobody touched, which matters here because the roster is
/// one shared file: another admin editing the same member between the fetch
/// and the save would have their change quietly reverted.
enum TeamMemberBody {
    /// POST /api/setup/team. Only the fields that were filled in ride along;
    /// an empty one is left out rather than stored as an empty string.
    static func add(_ draft: TeamMemberDraft) -> [String: TeamMemberField] {
        var body: [String: TeamMemberField] = ["name": .text(draft.trimmedName)]
        for (key, value) in [
            ("email", draft.email),
            ("github", draft.github),
            ("slackId", draft.slackId),
        ] {
            let trimmed = value.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { body[key] = .text(trimmed) }
        }
        if !draft.aliases.isEmpty { body["aliases"] = .aliases(draft.aliases) }
        return body
    }

    /// PUT /api/setup/team/:name. Empty means "no change", so a caller can
    /// skip the request entirely rather than sending a body the server
    /// answers with "Nothing to change".
    static func patch(
        _ draft: TeamMemberDraft,
        from member: TeamMemberSettings
    ) -> [String: TeamMemberField] {
        var patch: [String: TeamMemberField] = [:]
        if draft.trimmedName != member.name {
            patch["name"] = .text(draft.trimmedName)
        }
        for (key, next, previous) in [
            ("email", draft.email, member.email),
            ("github", draft.github, member.github),
            ("slackId", draft.slackId, member.slackId),
        ] {
            let trimmed = next.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty {
                if trimmed != (previous ?? "") { patch[key] = .text(trimmed) }
            } else if let previous, !previous.isEmpty {
                patch[key] = .cleared
            }
        }
        let previousAliases = member.aliases ?? []
        if draft.aliases != previousAliases {
            patch["aliases"] = draft.aliases.isEmpty ? .cleared : .aliases(draft.aliases)
        }
        return patch
    }
}

extension Dictionary where Key == String, Value == TeamMemberField {
    /// The same body as JSON. `NSNull` is what carries a deletion: the route
    /// deletes a key whose value is null and ignores one that is absent.
    var jsonBody: [String: Any] {
        var json: [String: Any] = [:]
        for (key, field) in self {
            switch field {
            case .text(let value): json[key] = value
            case .aliases(let values): json[key] = values
            case .cleared: json[key] = NSNull()
            }
        }
        return json
    }
}

struct TeamMemberResponse: Codable, Sendable {
    var member: TeamMemberSettings?
}
