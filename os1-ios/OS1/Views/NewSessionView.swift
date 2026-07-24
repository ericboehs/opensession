import SwiftUI

/// Compose a new session: prompt, repo, ask/code mode. The essentials of the
/// web composer — model, sandbox and MCP scoping stay server-default.
struct NewSessionView: View {
    @Environment(\.dismiss) private var dismiss

    /// Called with the created session id after the sheet dismisses.
    let onCreated: (String) -> Void

    @State private var prompt = ""
    @State private var mode = "code"
    @State private var repos: [OS1API.RepoInfo] = []
    @State private var repo = "tella-fusion"
    @State private var creating = false
    @State private var error: String?
    @FocusState private var promptFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section("Prompt") {
                    #if os(macOS)
                    // A vertical-axis TextField inside a grouped macOS Form
                    // renders as a label/value row with right-aligned text — a
                    // plain TextEditor is the real multiline prompt box.
                    ZStack(alignment: .topLeading) {
                        TextEditor(text: $prompt)
                            .font(.body)
                            .scrollContentBackground(.hidden)
                            .frame(minHeight: 120, maxHeight: 260)
                            .focused($promptFocused)
                        if prompt.isEmpty {
                            Text("What should this session do?")
                                .font(.body)
                                .foregroundStyle(.tertiary)
                                .padding(.leading, 5)
                                .allowsHitTesting(false)
                        }
                    }
                    #else
                    TextField(
                        "What should this session do?",
                        text: $prompt,
                        axis: .vertical
                    )
                    .lineLimit(4...12)
                    .focused($promptFocused)
                    #endif
                }

                Section {
                    Picker("Repo", selection: $repo) {
                        ForEach(repos) { repoInfo in
                            Text(repoInfo.id).tag(repoInfo.id)
                        }
                        if !repos.contains(where: { $0.id == repo }) {
                            Text(repo).tag(repo)
                        }
                    }
                    Picker("Mode", selection: $mode) {
                        Text("Code").tag("code")
                        Text("Ask").tag("ask")
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    Text(
                        mode == "code"
                            ? "Code mode gets an isolated worktree on an auto-named branch and can open a PR."
                            : "Ask mode runs read-only on the repo's main checkout."
                    )
                }

                if let error {
                    Section {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("New session")
            .inlineTitleBarCompat()
            #if os(macOS)
            .formStyle(.grouped)
            .frame(minWidth: 520, minHeight: 400)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(creating ? "Starting…" : "Start") {
                        Task { await create() }
                    }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(
                        creating
                            || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(creating)
                }
            }
            .task {
                promptFocused = true
                repos = (try? await OS1API.repos()) ?? []
                if !repos.isEmpty, !repos.contains(where: { $0.id == repo }) {
                    repo = repos[0].id
                }
            }
        }
    }

    private func create() async {
        creating = true
        error = nil
        do {
            let id = try await OS1API.createSession(
                prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                repo: repo,
                mode: mode
            )
            dismiss()
            onCreated(id)
        } catch {
            self.error = error.localizedDescription
            creating = false
        }
    }
}
