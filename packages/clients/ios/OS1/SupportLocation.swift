import Foundation

/// Where the Plain queue lives. The web derives the same choice from the
/// hidden-tools and hidden-feeds preferences rather than storing a third fact.
enum SupportLocation: String, CaseIterable, Identifiable {
    case sidebar
    case page
    case off

    var id: String { rawValue }
    var showsSidebar: Bool { self == .sidebar }
    var showsPage: Bool { self == .page }

    var label: String {
        switch self {
        case .sidebar: "In the sidebar"
        case .page: "Its own page"
        case .off: "Off"
        }
    }

    static func current(hiddenTools: String, hiddenFeeds: String) -> Self {
        let toolShown = !SidebarTools.isHidden(SidebarTools.plain, in: hiddenTools)
        let bandShown = !SidebarFeeds.isHidden(SidebarFeeds.plain, in: hiddenFeeds)
        // The independent preferences can still say both. Support is a default
        // tool, so it wins over the alternate sidebar placement.
        if toolShown { return .page }
        if bandShown { return .sidebar }
        return .off
    }

    struct PreferenceValues: Equatable {
        let hiddenTools: String
        let hiddenFeeds: String
    }

    static func setting(
        _ location: Self,
        hiddenTools: String,
        hiddenFeeds: String
    ) -> PreferenceValues {
        PreferenceValues(
            hiddenTools: SidebarTools.setting(
                SidebarTools.plain,
                hidden: location != .page,
                in: hiddenTools
            ),
            hiddenFeeds: SidebarFeeds.setting(
                SidebarFeeds.plain,
                hidden: location != .sidebar,
                in: hiddenFeeds
            )
        )
    }
}

@MainActor
extension SupportLocation {
    static func set(_ location: Self) {
        let defaults = UserDefaults.standard
        let currentTools = defaults.string(forKey: SidebarTools.storageKey)
            ?? SidebarTools.defaultHiddenJSON
        let currentFeeds = defaults.string(forKey: SidebarFeeds.storageKey) ?? "[]"
        let next = setting(
            location,
            hiddenTools: currentTools,
            hiddenFeeds: currentFeeds
        )
        guard next.hiddenTools != currentTools || next.hiddenFeeds != currentFeeds else { return }

        defaults.set(next.hiddenTools, forKey: SidebarTools.storageKey)
        defaults.set(next.hiddenFeeds, forKey: SidebarFeeds.storageKey)
        let user = ServerConfig.shared.userName
        Task {
            _ = try? await SettingsAPI.updateUiPrefs(
                user: user,
                prefs: [
                    SidebarTools.prefKey: next.hiddenTools,
                    SidebarFeeds.prefKey: next.hiddenFeeds,
                ]
            )
        }
    }
}
