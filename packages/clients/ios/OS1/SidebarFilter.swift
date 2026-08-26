import Foundation

/// The sessions list's view controls, in the shape the web sidebar settled on
/// (`src/frontend/lib/sidebar-filter.ts`), so one account reads the same list
/// in the browser and on the phone.
///
/// Only the model lives here. The panel that sets it is
/// `Views/SessionsFilterPanel.swift`; the list that reads it is
/// `Views/SessionsListView.swift`.

/// How the workspace list is organized.
///
/// Inbox keeps Active and Snoozed work together. Activity restores the date
/// bands, and Status is the dynamic lane view. Project grouping is a separate
/// switch, so any of those three can be global or repeated per project.
enum SidebarGroupBy: String, CaseIterable, Sendable {
    case inbox
    case activity
    case status

    var label: String {
        switch self {
        case .inbox: "Inbox"
        case .activity: "Activity"
        case .status: "Status"
        }
    }

    /// The section mode to use when nobody has picked one.
    static func fallback(repoCount: Int) -> SidebarGroupBy {
        .inbox
    }

    /// Project grouping is a separate axis. Until somebody picks it, several
    /// projects get bands and one project stays flat.
    static func defaultGroupsByProject(repoCount: Int) -> Bool {
        repoCount == RepoCount.unknown || repoCount > 1
    }

    /// What a stored value means now, including the five spellings this app
    /// used to write. Reading the old value IS the migration: the next pick
    /// writes the new spelling, and a value nobody recognises falls back to
    /// the default like an unpicked one.
    ///
    /// Compound project values keep both halves through
    /// `legacyGroupsByProject` below.
    static func stored(_ raw: String) -> SidebarGroupBy? {
        switch raw {
        case "settled", "inbox", "none", "repo": .inbox
        case "activity", "recent", "repo-inbox": .activity
        case "status", "repo-status": .status
        default: nil
        }
    }

    /// Whether an older one-axis value carried project bands.
    static func legacyGroupsByProject(_ raw: String) -> Bool? {
        switch raw {
        case "repo", "repo-inbox", "repo-status": true
        case "settled", "inbox", "activity", "status", "none", "recent": false
        default: nil
        }
    }
}

/// What orders the rows inside every band.
enum SidebarSortBy: String, CaseIterable, Sendable {
    case updated, created

    var label: String {
        switch self {
        case .updated: "Last activity"
        case .created: "Created"
        }
    }
}

/// Whose work the list is showing.
///
/// It used to be two answers, yours and everyone's. It is now the web's lens:
/// you, any teammate, the agent (which holds the work nobody has taken), the
/// unassigned backlog, or everyone. The values are stored the way the web
/// stores them, and the two this app wrote before are read as their new
/// spelling.
enum SidebarPersonLens {
    static let me = "me"
    static let everyone = "everyone"
    static let unassigned = "unassigned"

    static let storageKey = "os1.list.people"

    /// What a stored value means now. `mine` and `all` are what this app wrote
    /// before the lens grew; anything else is already a person key.
    static func stored(_ raw: String) -> String {
        let value = raw.trimmingCharacters(in: .whitespaces).lowercased()
        switch value {
        case "", "mine": return me
        case "all": return everyone
        default: return value
        }
    }

    /// Does this free-text name (a session's `startedBy`, a workspace's
    /// `createdBy`) belong to the person the lens is on?
    ///
    /// One teammate reaches us as "Kent", "Kent de Bruin" and "kentdebruin"
    /// depending on whether the name came from a roster, a display name or a
    /// GitHub login, so the compare is the app's usual loose one: equal, or
    /// either a prefix of the other. Same rule as the web's
    /// `ownerMatchesPerson` (lib/automation-audience.ts).
    static func nameMatches(_ name: String, key: String) -> Bool {
        let a = name.trimmingCharacters(in: .whitespaces).lowercased()
        let b = key.trimmingCharacters(in: .whitespaces).lowercased()
        guard !a.isEmpty, !b.isEmpty else { return false }
        return a == b || a.hasPrefix(b) || b.hasPrefix(a)
    }

    /// Is the list showing somebody else's work? Anything but `me` is a
    /// borrowed list, the same rule the web sidebar reads (`borrowedLens` in
    /// components/Sidebar.tsx).
    static func isBorrowed(_ key: String) -> Bool { stored(key) != me }

    /// What the bar over a borrowed list calls the lens. A person key is
    /// stored lowercased, so the roster's own spelling is asked for first and
    /// the raw key is only a fallback for somebody outside it.
    static func label(for key: String, agentName: String, roster: [String]) -> String {
        switch stored(key) {
        case me: return "You"
        case everyone: return "Everyone"
        case unassigned: return "Unassigned"
        default:
            let value = stored(key)
            if !agentName.isEmpty, nameMatches(agentName, key: value) { return agentName }
            if let named = roster.first(where: { nameMatches($0, key: value) }) { return named }
            return value.prefix(1).uppercased() + value.dropFirst()
        }
    }
}

/// A row nobody started by hand: an agent minted this session or workspace
/// through the automation machine identity.
///
/// Not an automation. An automation is a job somebody configured, with a name,
/// a trigger and an owner, and its runs carry that name. These are one-off
/// workspaces an agent opened for itself with no automation behind them, which
/// is why they sit in the ordinary bands and need a mark at all. Mirrors the
/// web's `rowWasAutoCreated` (lib/sidebar-placement.ts).
enum AutoCreatedOrigin {
    static let machineIdentity = "automation"

    static func wasAutoCreated(_ session: Session) -> Bool {
        [session.createdBy, session.startedBy].contains { name in
            name?.trimmingCharacters(in: .whitespaces).lowercased() == machineIdentity
        }
    }

    static func wasAutoCreated(_ workspace: SidebarWorkspace) -> Bool {
        let ordinary = workspace.sessions.filter { !$0.isAutomation }
        // Once a person joins the workspace it is shared work, not machine
        // clutter: hiding the whole row would hide that person's sessions too.
        if !ordinary.isEmpty { return ordinary.allSatisfy(wasAutoCreated) }
        // An automation-only row is an automation run even when its container
        // happened to be minted by the machine identity.
        if !workspace.sessions.isEmpty { return false }
        let owner = workspace.workspace?.createdBy?
            .trimmingCharacters(in: .whitespaces).lowercased()
        return owner == machineIdentity
    }
}
