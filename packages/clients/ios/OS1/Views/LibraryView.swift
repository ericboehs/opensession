import SwiftUI

/// The library, shaped for a phone: a list of prompts you can start a session
/// from, one tap away from the composer that will send it.
///
/// The desktop panel (`src/frontend/components/settings/LibraryPanel.tsx`) is a
/// catalog for configuring an instance, so it lists tools and integrations
/// beside the automations and links each one into the surface that installs it.
/// None of that is phone work. What IS phone work is the thing the catalog
/// already holds and the desktop never offers: a written prompt, ready to run,
/// for when the job comes to mind away from a desk. So this screen shows the
/// entries that can start a session and leaves the rest to Settings.
///
/// A push, not a sheet, and it hands its result back rather than acting on it:
/// picking an entry fills the composer you came from, where you can read and
/// change what will be sent before you send it.
struct LibraryView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// Called with the picked entry; the caller prefills and pops.
    let onPick: (LibraryEntry) -> Void

    @State private var entries: [LibraryEntry]?
    @State private var loadFailure: String?

    /// Recipes ship in the repository and are written to run anywhere.
    private var recipes: [LibraryEntry] {
        (entries ?? []).filter { $0.isStartable && $0.fromRepo }
    }

    /// Templates are starting points written against a particular repo or
    /// product, so they expect an edit before they are sent.
    private var templates: [LibraryEntry] {
        (entries ?? []).filter { $0.isStartable && !$0.fromRepo }
    }

    var body: some View {
        List {
            if entries == nil, loadFailure == nil {
                ProgressView().frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
            } else if let loadFailure, entries == nil {
                ContentUnavailableView(
                    "Can't load the library",
                    systemImage: "exclamationmark.triangle",
                    description: Text(loadFailure)
                )
                .listRowBackground(Color.clear)
            } else if recipes.isEmpty, templates.isEmpty {
                ContentUnavailableView(
                    "Nothing to start from",
                    systemImage: "books.vertical",
                    description: Text("This instance ships no recipes yet.")
                )
                .listRowBackground(Color.clear)
            } else {
                section(
                    title: "Recipes",
                    footer: "Ready to run as they are.",
                    entries: recipes
                )
                section(
                    title: "Templates",
                    footer: "Written for a particular setup. Read the prompt before you send it.",
                    entries: templates
                )
            }
        }
        .navigationTitle("Start from a recipe")
        .inlineTitleBarCompat()
        .task { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder
    private func section(
        title: String, footer: String, entries: [LibraryEntry]
    ) -> some View {
        if !entries.isEmpty {
            Section {
                ForEach(entries) { entry in
                    Button { pick(entry) } label: { row(entry) }
                        .buttonStyle(.plain)
                }
            } header: {
                Text(title)
            } footer: {
                Text(footer)
            }
        }
    }

    @ViewBuilder
    private func row(_ entry: LibraryEntry) -> some View {
        let text = VStack(alignment: .leading, spacing: 3) {
            Text(entry.name)
                .foregroundStyle(OS1VisualStyle.text)
            if !entry.summary.isEmpty {
                Text(entry.summary)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if !entry.requires.isEmpty {
                Text("Needs \(entry.requires.map(Self.serviceName).joined(separator: " and ")).")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        // Which mode it will start in decides whether it can change code, so
        // it belongs before the tap rather than only in the composer.
        let mode = Text(entry.mode == "code" ? "Code" : "Ask")
            .font(.caption)
            .foregroundStyle(.tertiary)

        Group {
            if dynamicTypeSize.isAccessibilitySize {
                // Beside the text, the mode is a word in a column of its own.
                // At an accessibility size that column is wide enough to leave
                // the recipe's name two or three characters a line. Below the
                // text it costs one line and takes width from nothing.
                VStack(alignment: .leading, spacing: 3) {
                    text
                    mode
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    text
                    Spacer(minLength: 8)
                    mode
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// Integration ids arrive lowercase ("github"); the row wants the name a
    /// person would recognise.
    private static func serviceName(_ id: String) -> String {
        switch id {
        case "github": "GitHub"
        case "plain": "Plain"
        case "linear": "Linear"
        case "slack": "Slack"
        case "stripe": "Stripe"
        case "grafana": "Grafana"
        default: id.prefix(1).uppercased() + id.dropFirst()
        }
    }

    private func pick(_ entry: LibraryEntry) {
        Haptics.play(.selection)
        onPick(entry)
        dismiss()
    }

    private func load() async {
        do {
            entries = try await OS1API.library()
            loadFailure = nil
        } catch {
            loadFailure = error.localizedDescription
        }
    }
}
