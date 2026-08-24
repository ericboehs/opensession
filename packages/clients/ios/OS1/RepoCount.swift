import Foundation

/// How many projects this instance has registered, remembered across launches.
///
/// The sessions list's default grouping depends on it: one project has nothing
/// to group by, so it reads as a plain inbox, while several get repo bands.
/// That default has to resolve during the first render — long before
/// `GET /api/repos` answers — so the count is recorded as the repo list
/// arrives (`OS1API.repos`) and read back synchronously at launch. Same
/// arrangement as the web sidebar's `lib/repo-count`.
enum RepoCount {
    /// The defaults key, shared with the `@AppStorage` that reads it so a view
    /// re-renders when a fresh count lands.
    static let storageKey = "os1.repoCount"

    /// The value that means "no count yet". Zero can't stand in for it: an
    /// instance with no repositories registered is a real, if brief, state.
    static let unknown = -1

    /// The count as of the last load, or `unknown` the very first time.
    static var current: Int {
        let stored = UserDefaults.standard.object(forKey: storageKey) as? Int
        return stored ?? unknown
    }

    /// Record the size of the registered set.
    static func remember(_ count: Int) {
        guard current != count else { return }
        UserDefaults.standard.set(count, forKey: storageKey)
    }
}
