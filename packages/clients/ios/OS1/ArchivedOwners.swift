import Foundation

/// Who archived what — the Owner lens on the Archived screen.
///
/// `startedBy` is a free-text display name, and the archive holds far more
/// than teammates: spawned workers ("worker os-019fe…"), the agent persona and
/// integration senders all land in that field. So the person options are drawn
/// against the team directory rather than against every distinct string — an
/// unfiltered list is mostly session ids.
///
/// The directory is also what merges one person's spellings: chat integrations
/// write a full name where the web writes a first name, and both must answer
/// to the same option. Same rules as the web's `lib/session-owner`, which is
/// why the two screens offer the same people.
///
/// `roster` is `TeamDirectory.displayNames`: first name → that person's own
/// spelling. Passed in rather than read from the directory so this stays a
/// plain value type, testable without a server.
enum ArchivedOwners {
    /// The selection value for "anyone", and for "just me". Neither can
    /// collide with a person key: both are matched before one is looked up.
    static let everyone = "everyone"
    static let mine = "mine"

    struct Owner: Identifiable, Equatable {
        /// The lowercased canonical name, used as the picker's tag.
        let key: String
        /// The roster's spelling, shown in the menu.
        let label: String

        var id: String { key }
    }

    /// The key a session filters under: its canonical roster name when the
    /// directory recognizes the starter, otherwise the raw name lowercased —
    /// so the lens still works before the roster lands, and for people who are
    /// not in it.
    static func ownerKey(
        of session: Session, roster: [String: String]
    ) -> String {
        let raw = (session.startedBy ?? "").lowercased()
        return canonical(raw, in: roster)?.lowercased() ?? raw
    }

    static func session(
        _ session: Session, hasOwner owner: String, roster: [String: String]
    ) -> Bool {
        guard !session.isAutomation, session.startedBy?.isEmpty == false else { return false }
        return ownerKey(of: session, roster: roster) == owner
    }

    /// The roster's spelling of a wire name. Keyed on the first name, which is
    /// what merges "Kent" and "Kent de Bruin" into one option — the same key
    /// `TeamDirectory` files everyone under.
    static func canonical(_ name: String, in roster: [String: String]) -> String? {
        guard let key = name.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: " ").first?.lowercased()
        else { return nil }
        return roster[key]
    }

    /// Teammates with something in this archive, most-archived first,
    /// excluding the signed-in person — whose row is "My archived" and comes
    /// first in the menu on its own.
    static func options(
        in sessions: [Session], roster: [String: String], excluding meKey: String
    ) -> [Owner] {
        var counts: [String: (label: String, count: Int)] = [:]
        for session in sessions {
            guard !session.isAutomation, let startedBy = session.startedBy,
                  !startedBy.isEmpty, let label = canonical(startedBy, in: roster)
            else { continue }
            let key = label.lowercased()
            guard key != meKey else { continue }
            counts[key, default: (label, 0)].count += 1
        }
        return counts
            .map { (key: $0.key, label: $0.value.label, count: $0.value.count) }
            .sorted {
                $0.count != $1.count
                    ? $0.count > $1.count
                    : $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending
            }
            .map { Owner(key: $0.key, label: $0.label) }
    }
}
