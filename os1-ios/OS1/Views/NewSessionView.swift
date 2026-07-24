import SwiftUI

/// Compose a new session: a full-height prompt editor over a compact chip row
/// for repo / mode / model / effort / fast mode, plus image attachments —
/// the web palette's essentials in a native shape.
///
/// The prompt lives in a plain `TextEditor` inside a custom layout (not a
/// grouped Form): Form re-diffs every row on each keystroke, which is what
/// made typing lag in the old sheet.
struct NewSessionView: View {
    @Environment(\.dismiss) private var dismiss

    /// Preset repo (the per-repo "+" in the sessions list); nil = remembered.
    var initialRepo: String?

    /// Called after the server returns the new id, with an optimistic session
    /// row plus the prompt/images to seed the conversation view instantly.
    let onCreated: (Session, SessionViewModel.OptimisticSeed) -> Void

    @State private var prompt = ""
    @State private var mode = "code"
    @State private var repos: [OS1API.RepoInfo] = []
    @State private var repo = ""
    @State private var catalog: ModelCatalog?
    @State private var model = ""
    @State private var effort = ""
    @State private var fastMode = false
    @State private var images: [AttachedImage] = []
    @State private var creating = false
    @State private var error: String?
    @FocusState private var promptFocused: Bool

    /// The universal "+" reopens on whatever repo was used last.
    @AppStorage("os1.newSession.repo") private var lastRepo = "tella-fusion"

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                editor
                if !images.isEmpty {
                    AttachedImagesRow(images: images) { image in
                        images.removeAll { $0.id == image.id }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 6)
                }
                Divider()
                controls
                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 10)
                }
            }
            .navigationTitle("New session")
            .inlineTitleBarCompat()
            #if os(macOS)
            .frame(minWidth: 560, minHeight: 440)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(creating ? "Starting…" : "Start") {
                        Task { await create() }
                    }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(
                        creating
                            || (prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                && images.isEmpty)
                    )
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(creating)
                }
            }
            .task { await load() }
        }
    }

    // ── Prompt editor ─────────────────────────────────────────────────────

    private var editor: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $prompt)
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 11)
                .padding(.top, 8)
                .focused($promptFocused)
            if prompt.isEmpty {
                Text("What should this session do?")
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 16)
                    .padding(.top, 16)
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // ── Chip row ──────────────────────────────────────────────────────────

    private var selectedModelOption: ModelOption? {
        catalog?.option(for: model)
    }

    private var availableEfforts: [String] {
        selectedModelOption?.efforts ?? []
    }

    private var fastSupported: Bool {
        selectedModelOption?.fastModeSupported == true
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                AttachImagesButton(images: $images)
                repoChip
                modeChip
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                modelChip
                if !availableEfforts.isEmpty { effortChip }
                if fastSupported { fastChip }
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var repoChip: some View {
        Menu {
            ForEach(repos) { repoInfo in
                Button {
                    repo = repoInfo.id
                } label: {
                    if repo == repoInfo.id {
                        Label(repoInfo.id, systemImage: "checkmark")
                    } else {
                        Text(repoInfo.id)
                    }
                }
            }
        } label: {
            chipLabel(icon: "folder", text: repo.isEmpty ? "repo" : repo)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    private var modeChip: some View {
        Menu {
            Button {
                mode = "code"
            } label: {
                Label {
                    Text("Code")
                    Text("Isolated worktree, can open a PR")
                } icon: {
                    if mode == "code" { Image(systemName: "checkmark") }
                }
            }
            Button {
                mode = "ask"
            } label: {
                Label {
                    Text("Ask")
                    Text("Read-only on the main checkout")
                } icon: {
                    if mode == "ask" { Image(systemName: "checkmark") }
                }
            }
        } label: {
            chipLabel(
                icon: mode == "code" ? "hammer" : "text.magnifyingglass",
                text: mode == "code" ? "Code" : "Ask"
            )
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    private var modelChip: some View {
        Menu {
            if let catalog {
                if !catalog.presets.isEmpty {
                    Section("Presets") {
                        ForEach(catalog.presets) { option in
                            modelButton(option)
                        }
                    }
                }
                Section(catalog.presets.isEmpty ? "Model" : "Models") {
                    ForEach(catalog.regular) { option in
                        modelButton(option)
                    }
                }
            }
        } label: {
            chipLabel(
                icon: "cpu",
                text: catalog?.label(for: model.isEmpty ? catalog?.defaultModel : model)
                    ?? "Model"
            )
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    private func modelButton(_ option: ModelOption) -> some View {
        Button {
            selectModel(option)
        } label: {
            let selected = option.id == model
            if let subtitle = option.description, !subtitle.isEmpty {
                Label {
                    Text(option.displayLabel)
                    Text(subtitle)
                } icon: {
                    if selected { Image(systemName: "checkmark") }
                }
            } else if selected {
                Label(option.displayLabel, systemImage: "checkmark")
            } else {
                Text(option.displayLabel)
            }
        }
    }

    private var effortChip: some View {
        Menu {
            ForEach(availableEfforts, id: \.self) { level in
                Button {
                    effort = level
                } label: {
                    if effort == level {
                        Label(EffortLevel.label(level), systemImage: "checkmark")
                    } else {
                        Text(EffortLevel.label(level))
                    }
                }
            }
        } label: {
            chipLabel(
                icon: "gauge.with.needle",
                text: effort.isEmpty ? "Effort" : EffortLevel.label(effort)
            )
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    private var fastChip: some View {
        Button {
            fastMode.toggle()
        } label: {
            chipLabel(icon: "bolt.fill", text: "Fast", highlighted: fastMode)
        }
        .buttonStyle(.plain)
    }

    private func chipLabel(
        icon: String, text: String, highlighted: Bool = false
    ) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.caption)
            Text(text)
                .font(.callout)
                .lineLimit(1)
        }
        .foregroundStyle(highlighted ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            highlighted ? AnyShapeStyle(.tint.opacity(0.15)) : AnyShapeStyle(.fill.tertiary),
            in: Capsule()
        )
        .contentShape(Capsule())
    }

    // ── Data ──────────────────────────────────────────────────────────────

    private func load() async {
        promptFocused = true
        repo = initialRepo ?? lastRepo
        async let reposFetch = OS1API.repos()
        async let modelsFetch = OS1API.models()
        repos = (try? await reposFetch) ?? []
        if !repos.isEmpty, !repos.contains(where: { $0.id == repo }) {
            repo = repos[0].id
        }
        if let fetched = try? await modelsFetch {
            catalog = fetched
            if model.isEmpty, let def = fetched.defaultModel {
                model = def
            }
            defaultEffortForCurrentModel()
        }
    }

    private func selectModel(_ option: ModelOption) {
        model = option.id
        defaultEffortForCurrentModel()
        if !(option.fastModeSupported == true) { fastMode = false }
    }

    /// "High" is the palette's default where supported; presets (dial) have
    /// no effort dimension so the chip hides.
    private func defaultEffortForCurrentModel() {
        let efforts = availableEfforts
        if efforts.isEmpty {
            effort = ""
        } else if !efforts.contains(effort) {
            effort = efforts.contains("high") ? "high" : efforts[0]
        }
    }

    private func create() async {
        creating = true
        error = nil
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let imageURLs = images.map(\.dataURL)
        do {
            let id = try await OS1API.createSession(
                prompt: text,
                repo: repo,
                mode: mode,
                model: model.isEmpty ? nil : model,
                effort: effort.isEmpty ? nil : effort,
                fastMode: fastMode,
                images: imageURLs
            )
            lastRepo = repo
            let optimistic = Session.optimistic(
                id: id,
                title: String((text.components(separatedBy: "\n").first ?? text).prefix(80)),
                repo: repo,
                mode: mode,
                model: model.isEmpty ? nil : model,
                effort: effort.isEmpty ? nil : effort,
                fastMode: fastMode,
                startedBy: ServerConfig.shared.userName
            )
            dismiss()
            onCreated(
                optimistic,
                SessionViewModel.OptimisticSeed(prompt: text, images: imageURLs)
            )
        } catch {
            self.error = error.localizedDescription
            creating = false
        }
    }
}
