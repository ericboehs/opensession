import SwiftUI

/// Compose a new session: a full-height prompt editor over a compact chip row
/// for repo / mode / model / effort / fast mode, plus image attachments —
/// the web palette's essentials in a native shape. Screenshots paste straight
/// into the attachments (Cmd+V on the Mac; long-press Paste on iOS).
///
/// The prompt lives in a plain `TextEditor` inside a custom layout (not a
/// grouped Form): Form re-diffs every row on each keystroke, which is what
/// made typing lag in the old sheet.
struct NewSessionView: View {
    @Environment(\.dismiss) private var dismiss

    /// Preset repo (the per-repo "+" in the sessions list); nil = remembered.
    var initialRepo: String?

    /// Called the moment Start is tapped, with an optimistic session row
    /// (temporary `pending-` id) plus the prompt/images to seed the
    /// conversation view instantly.
    let onCreated: (Session, SessionViewModel.OptimisticSeed) -> Void

    /// Called when the background create finishes: the temp id and either
    /// the server's real session id or the error to surface.
    let onResolved: (String, Result<String, Error>) -> Void

    @State private var prompt = ""
    @State private var mode = "code"
    @State private var repos: [OS1API.RepoInfo] = []
    @State private var repo = ""
    @State private var catalog: ModelCatalog?
    @State private var model = ""
    @State private var effort = ""
    @State private var fastMode = false
    @State private var images: [AttachedImage] = []
    @FocusState private var promptFocused: Bool

    /// The universal "+" reopens on whatever repo was used last.
    @AppStorage("os1.newSession.repo") private var lastRepo = ""
    @AppStorage("os1.composer.defaultModel") private var preferredModel = ""

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
            }
            .background(OS1VisualStyle.background)
            .navigationTitle("New session")
            .inlineTitleBarCompat()
            #if os(macOS)
            .frame(minWidth: 560, minHeight: 440)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") { create() }
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(
                            prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                && images.isEmpty
                        )
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
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
                // Cmd+V with a copied screenshot attaches it; text pastes
                // flow through to the editor untouched.
                .pastesImages(into: $images)
            if prompt.isEmpty {
                Text("What should this session do?")
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 16)
                    .padding(.top, placeholderTopPadding)
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        #if os(iOS)
        .contentShape(Rectangle())
        .onTapGesture { promptFocused = true }
        #endif
    }

    /// Lines the placeholder up with the editor's real text origin: the outer
    /// padding plus the platform text view's own insets. UITextView adds an
    /// 8pt top container inset (8 outer + 8 = 16); NSTextView adds none.
    /// Horizontally both add 5pt fragment padding (11 outer + 5 = 16).
    private var placeholderTopPadding: CGFloat {
        #if os(macOS)
        8
        #else
        16
        #endif
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

    private var modelChipText: String {
        let id = model.isEmpty ? catalog?.defaultModel : model
        #if os(iOS)
        if id == "dial/opus-fable" { return "Opus/Fable/Oracle" }
        #endif
        return catalog?.label(for: id) ?? "Model"
    }

    private var controls: some View {
        #if os(iOS)
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                AttachImagesButton(images: $images)
                repoChip
                modeChip
                modelChip
            }
            .padding(.horizontal, 12)
        }
        .scrollIndicators(.hidden)
        .padding(.vertical, 8)
        #else
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
        #endif
    }

    private var repoChip: some View {
        Menu {
            ForEach(repos) { repoInfo in
                Button {
                    repo = repoInfo.id
                } label: {
                    if repo == repoInfo.id {
                        Label(repoInfo.label ?? repoInfo.id, systemImage: "checkmark")
                    } else {
                        Text(repoInfo.label ?? repoInfo.id)
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
            #if os(iOS)
            if !availableEfforts.isEmpty {
                Section("Reasoning") {
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
                }
            }
            if fastSupported {
                Button {
                    fastMode.toggle()
                } label: {
                    if fastMode {
                        Label("Fast mode", systemImage: "checkmark")
                    } else {
                        Text("Fast mode")
                    }
                }
            }
            #endif
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
                text: modelChipText
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
                #if os(iOS)
                .font(.caption2)
                #else
                .font(.caption)
                #endif
            Text(text)
                #if os(iOS)
                .font(.caption)
                #else
                .font(.callout)
                #endif
                .lineLimit(1)
        }
        .foregroundStyle(highlighted ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
        #if os(iOS)
        .padding(.horizontal, 7)
        .padding(.vertical, 5)
        #else
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        #endif
        .background(
            highlighted ? AnyShapeStyle(.tint.opacity(0.15)) : AnyShapeStyle(.fill.tertiary),
            in: Capsule()
        )
        #if os(iOS)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        #else
        .contentShape(Capsule())
        #endif
    }

    // ── Data ──────────────────────────────────────────────────────────────

    private func load() async {
        promptFocused = true
        repo = initialRepo ?? lastRepo
        async let reposFetch = OS1API.repos()
        async let modelsFetch = OS1API.models()
        repos = (try? await reposFetch) ?? []
        if !repos.isEmpty, !repos.contains(where: { $0.id == repo }) {
            repo = repos.first(where: { $0.isDefault == true })?.id ?? repos[0].id
        }
        if let fetched = try? await modelsFetch {
            catalog = fetched
            let livePreferred = (try? await SettingsAPI.uiPrefs(
                user: ServerConfig.shared.userName
            ))?["default-model"] ?? preferredModel
            preferredModel = livePreferred
            if model.isEmpty {
                model = fetched.option(for: livePreferred) != nil
                    ? livePreferred
                    : (fetched.defaultModel ?? "")
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

    /// Optimistic create: the sheet closes immediately and the conversation
    /// opens seeded with the prompt under a temporary id, while the real
    /// create (worktree prep — seconds) runs in the background. The list
    /// swaps the temp id for the server's when it resolves.
    private func create() {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let imageURLs = images.map(\.dataURL)
        lastRepo = repo
        let pending = Session.optimistic(
            id: "pending-\(UUID().uuidString)",
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
            pending,
            SessionViewModel.OptimisticSeed(prompt: text, images: imageURLs)
        )
        Task {
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
                onResolved(pending.id, .success(id))
            } catch {
                onResolved(pending.id, .failure(error))
            }
        }
    }
}
