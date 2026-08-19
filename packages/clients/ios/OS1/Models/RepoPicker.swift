import Foundation

/// The add-a-repository picker's list rules, kept out of the view so they can
/// be tested.
///
/// The server hands back what one GitHub credential can see, newest push
/// first, capped at 300 (src/server/routes/setup-repos.ts). What the screen
/// shows is a filter over that order, matched the same way the web picker
/// matches it (`filterRepos` in SetupRepos.tsx) — one list, one answer, on
/// either client.
enum RepoPicker {
    static func matching(
        _ repos: [OS1API.BrowsableRepo],
        query: String
    ) -> [OS1API.BrowsableRepo] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return repos }
        return repos.filter { repo in
            repo.fullName.lowercased().contains(needle)
                || (repo.description ?? "").lowercased().contains(needle)
        }
    }
}
