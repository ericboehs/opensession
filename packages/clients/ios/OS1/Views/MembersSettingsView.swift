import SwiftUI

/// Settings → Members: everyone who uses this instance.
///
/// One roster, several names each. A session's user arrives as a display
/// name, an email, a GitHub login or a Slack id depending on where it started,
/// and all of them resolve through this table — so a member is worth editing
/// for the identifiers nobody sees as much as for the name everybody does.
/// Get it wrong and a teammate's commits are attributed to nobody and their
/// `allowedUsers` grants stop matching.
///
/// Nothing here is a secret, which is what makes it phone work: it is names
/// and handles, typed from memory, unlike the API keys that stay on the web.
struct MembersSettingsView: View {
    @State private var members: [TeamMemberSettings] = SettingsCache.value("team-members") ?? []
    @State private var loaded = false
    @State private var loading = true
    @State private var error: String?
    @State private var editing: MemberEditorTarget?
    @State private var removing: TeamMemberSettings?
    @State private var busy = false

    var body: some View {
        List {
            if loading, members.isEmpty {
                settingsLoadingRow
            } else {
                if let error { settingsErrorRow(error) { Task { await load() } } }
                Section {
                    if members.isEmpty, loaded {
                        Text("No teammates yet. Add everyone who uses this instance.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(members) { member in
                        Button {
                            editing = .edit(member)
                        } label: {
                            MemberRow(member: member)
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                removing = member
                            } label: {
                                Label("Remove", systemImage: "trash")
                            }
                        }
                    }
                } footer: {
                    Text("Names, emails, GitHub logins and Slack ids all resolve through this one table, so a session started under any of them attributes to the same person.")
                }
            }
        }
        .insetGroupedListCompat()
        .navigationTitle("Members")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    editing = .add
                } label: {
                    Label("Add member", systemImage: "plus")
                }
                .disabled(busy)
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editing) { target in
            MemberEditor(target: target) { await save(target, $0) }
        }
        // On the list rather than the row: a swipe action's row is gone from
        // the hierarchy by the time the dialog would present, and an alert
        // anchored to it never appears.
        .confirmationDialog(
            removing.map { "Remove \($0.name)?" } ?? "Remove member?",
            isPresented: Binding(
                get: { removing != nil },
                set: { if !$0 { removing = nil } }
            ),
            titleVisibility: .visible,
            presenting: removing
        ) { member in
            Button("Remove", role: .destructive) { Task { await remove(member) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Their identity mapping is removed. Sessions and commits they already have keep the name they were made with.")
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let fetched = try await SettingsAPI.teamMembers().members ?? []
            members = fetched
            loaded = true
            SettingsCache.save("team-members", fetched)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// The editor owns the form; this owns which request it turns into. An
    /// edit sends only what changed, so an unchanged form is not a request at
    /// all — see `TeamMemberBody`.
    private func save(_ target: MemberEditorTarget, _ draft: TeamMemberDraft) async -> String? {
        do {
            switch target {
            case .add:
                _ = try await SettingsAPI.addTeamMember(TeamMemberBody.add(draft).jsonBody)
            case .edit(let member):
                let patch = TeamMemberBody.patch(draft, from: member)
                if !patch.isEmpty {
                    _ = try await SettingsAPI.updateTeamMember(
                        name: member.name,
                        patch: patch.jsonBody
                    )
                }
            }
            await load()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    private func remove(_ member: TeamMemberSettings) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await SettingsAPI.removeTeamMember(name: member.name)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Add, or edit one member. Identifiable so the sheet re-presents per target
/// and the form is built fresh for it rather than inheriting the last one.
enum MemberEditorTarget: Identifiable {
    case add
    case edit(TeamMemberSettings)

    var id: String {
        switch self {
        case .add: "add"
        case .edit(let member): member.id
        }
    }
}

private struct MemberRow: View {
    let member: TeamMemberSettings

    var body: some View {
        HStack(spacing: 12) {
            // The login is passed rather than looked up: this screen holds it,
            // and the directory it would otherwise be resolved through is
            // filled from /api/people, which an instance can leave empty.
            UserAvatar(person: member.name, login: member.github, size: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(member.name)
                    .foregroundStyle(OS1VisualStyle.text)
                let summary = member.identifierSummary
                if !summary.isEmpty {
                    Text(summary)
                        .font(.footnote)
                        // Explicit, not `.secondary`: the row is a button, and
                        // inside one the hierarchical styles resolve against
                        // the tint — which rendered every email as a blue link.
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 12)
            Image(systemName: "chevron.forward")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.secondary.opacity(0.55))
        }
        .padding(.vertical, 2)
    }
}

private struct MemberEditor: View {
    let target: MemberEditorTarget
    /// Returns an error message, or nil when the save landed.
    let onSave: (TeamMemberDraft) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var draft: TeamMemberDraft
    @State private var saving = false
    @State private var error: String?

    init(target: MemberEditorTarget, onSave: @escaping (TeamMemberDraft) async -> String?) {
        self.target = target
        self.onSave = onSave
        switch target {
        case .add: _draft = State(initialValue: TeamMemberDraft())
        case .edit(let member): _draft = State(initialValue: TeamMemberDraft(member))
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Full name", text: $draft.name)
                    TextField("Email", text: $draft.email)
                        .noAutocapitalizationCompat()
                        .disableAutocorrection(true)
                        #if os(iOS)
                        .keyboardType(.emailAddress)
                        #endif
                } footer: {
                    Text("The name is how they appear in sessions, and how commits are signed.")
                }

                Section {
                    TextField("GitHub login", text: $draft.github)
                        .noAutocapitalizationCompat()
                        .disableAutocorrection(true)
                    TextField("Slack member id", text: $draft.slackId)
                        .noAutocapitalizationCompat()
                        .disableAutocorrection(true)
                        .font(.body.monospaced())
                    TextField("Aliases, comma separated", text: $draft.aliasText)
                        .noAutocapitalizationCompat()
                        .disableAutocorrection(true)
                } header: {
                    Text("Also known as")
                } footer: {
                    Text("Each one is another name a session can arrive under. A Slack member id looks like U01ABCDEF.")
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle(isAdding ? "Add member" : draft.trimmedName)
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isAdding ? "Add" : "Save") { Task { await commit() } }
                        .disabled(draft.trimmedName.isEmpty || saving)
                }
            }
        }
    }

    private var isAdding: Bool {
        if case .add = target { return true }
        return false
    }

    private func commit() async {
        saving = true
        defer { saving = false }
        if let message = await onSave(draft) {
            error = message
        } else {
            dismiss()
        }
    }
}
