import SwiftUI

/// What a teammate sees the first time they open the app on a fresh install:
/// an empty list, plus the three facts that make it legible.
///
/// Not a wizard, deliberately. The web had a teammate onboarding flow for
/// about seven hours on 2026-08-13 — a readiness card, two mode choices, and
/// then an auto-opened composer — and it was removed the same day in favour
/// of showing the empty product (`Show the empty product to new teammates`,
/// de8dfc50). Putting that flow on the phone would rebuild what the web just
/// deleted, so this keeps the empty product and fixes the part the phone gets
/// wrong instead.
///
/// That part is real: on iOS the first run IS a modal connection sheet, and
/// dismissing it drops you on a list that says "No sessions" and nothing
/// else. Nothing on screen confirms the sign-in took, which instance
/// answered, or what an agent here would have to work in — all three of which
/// the browser shows for free in its address bar and sidebar. So the same
/// placeholder anatomy every other empty list uses, with the identity and the
/// instance stated in the sentence it already had room for, the registered
/// repos shown as the tiles they are, and one button.
struct FirstRunPlaceholder: View {
    let onNewSession: () -> Void
    let onShowArchived: () -> Void

    @State private var config = ServerConfig.shared
    /// Written by every repo fetch in the app (`OS1API.repos`), so the tiles
    /// paint on the first frame and the fetch below only corrects them.
    @State private var repos: [OS1API.RepoInfo] = SettingsCache.value("repos") ?? []

    var body: some View {
        ListPlaceholder(
            symbol: "bubble.left.and.bubble.right",
            title: "No sessions yet",
            message: greeting,
            accessory: { repoStrip }
        ) {
            // The only thing worth offering here. Settings used to sit under
            // it, but the app tile in the corner is already that door — a
            // placeholder shouldn't spend its one moment of attention
            // pointing at chrome that never left the screen.
            Button("New session", action: onNewSession)
                .buttonStyle(PlaceholderActionStyle())
            Button("Archived", action: onShowArchived)
                .buttonStyle(PlaceholderActionStyle(prominent: false))
        }
        .task {
            // Cheap and idempotent: the same call the new-session sheet makes,
            // and the only way a fresh install has any repos to show at all.
            if let fetched = try? await OS1API.repos() {
                repos = fetched
                SettingsCache.save("repos", fetched)
            }
        }
    }

    /// Who the server thinks you are, and which server that was. One sentence,
    /// because it answers one question: did signing in work, and into what.
    private var greeting: String {
        guard !name.isEmpty else { return "Signed in to \(host)." }
        return "You're signed in as \(name) on \(host)."
    }

    /// The verified GitHub login wins over the stored name here, the way the
    /// connection screen's header does: `userName` starts life as a
    /// placeholder ("ios") that is only backfilled once the server answers,
    /// and this is the screen most likely to be read before it has.
    private var name: String {
        let stored = config.userName.trimmingCharacters(in: .whitespaces)
        if !stored.isEmpty, stored != ServerConfig.placeholderUserName { return stored }
        let login = config.githubLogin.trimmingCharacters(in: .whitespaces)
        return login.isEmpty ? "" : "@\(login)"
    }

    private var host: String {
        let raw = config.baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        if let host = URL(string: raw)?.host, !host.isEmpty { return host }
        return raw.isEmpty ? "this instance" : raw
    }

    /// What an agent here has to work in. Tiles rather than a list of names:
    /// they are the same tiles the sessions list will paint, so the first
    /// screen teaches the vocabulary of the second one.
    @ViewBuilder
    private var repoStrip: some View {
        if repos.isEmpty {
            Text("No repositories registered yet.")
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textFaint)
                .padding(.top, 12)
        } else {
            VStack(spacing: 7) {
                HStack(spacing: 7) {
                    // Four is what fits the placeholder's 300pt measure
                    // without the row becoming a scroll view nobody asked for.
                    ForEach(repos.prefix(4), id: \.id) { repo in
                        RepoTile(name: repo.id, size: 26)
                    }
                }
                Text(repoSummary)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            .padding(.top, 12)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Repositories: \(repoSummary)")
        }
    }

    /// Names them while naming them all is possible, and counts them
    /// otherwise. "tella-fusion and 8 more" was the first try, and it reads
    /// wrong under the tiles: three of those eight are already on screen, so
    /// the line invites you to add it to what you can see and get twelve.
    private var repoSummary: String {
        let names = repos.map { RepoTile.label(for: $0.id) }
        switch names.count {
        case 1: return names[0]
        case 2: return "\(names[0]) and \(names[1])"
        default: return "\(names.count) repositories"
        }
    }
}
