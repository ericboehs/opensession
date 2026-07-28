import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var serverURL = ServerConfig.shared.baseURLString
    @State private var userName = ServerConfig.shared.userName
    @State private var token = ServerConfig.shared.token
    @State private var checkResult: String?

    // GitHub device-flow state lives in GitHubSignIn.shared (NOT sheet
    // @State): entering the code happens outside the app, and the sheet —
    // or the whole app — can be torn down in the meantime. The model
    // persists + resumes the flow; this view just renders it.
    private var signIn: GitHubSignIn { .shared }

    private var signedInLogin: String? {
        let login = ServerConfig.shared.githubLogin
        return login.isEmpty || token.isEmpty ? nil : login
    }

    @State private var copiedCode = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("https://os.tella.dev", text: $serverURL)
                        .urlFieldCompat()
                        .autocorrectionDisabled()
                }

                Section {
                    if let flow = signIn.flow {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Enter this code on GitHub:")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            Button {
                                copyToPasteboard(flow.userCode)
                                copiedCode = true
                            } label: {
                                Text(flow.userCode)
                                    .font(.system(.title, design: .monospaced).bold())
                                    .foregroundStyle(.primary)
                                    .frame(maxWidth: .infinity)
                            }
                            Text(copiedCode ? "Copied — paste it on GitHub." : "Tap the code to copy it.")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .frame(maxWidth: .infinity)
                            if let url = URL(string: flow.verificationUri) {
                                Button("Copy code and open GitHub") {
                                    copyToPasteboard(flow.userCode)
                                    copiedCode = true
                                    openURL(url)
                                }
                            }
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Waiting for approval…")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Button("Cancel", role: .cancel) { signIn.cancel() }
                            }
                            if let at = signIn.lastPollAt {
                                Text("Checked \(at.formatted(date: .omitted, time: .standard)) — \(signIn.lastPollNote ?? "")")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.vertical, 4)
                        // CRITICAL: default-styled buttons inside a Form row
                        // make the WHOLE ROW one tap target — tapping the code
                        // or the link was ALSO firing the Cancel button and
                        // silently killing the flow. Borderless buttons get
                        // individual hit areas instead.
                        .buttonStyle(.borderless)
                    } else if let signedInLogin {
                        HStack {
                            Label("Signed in as @\(signedInLogin)", systemImage: "checkmark.seal")
                            Spacer()
                            Button("Sign out", role: .destructive) { signOut() }
                        }
                    } else {
                        Button {
                            startSignIn()
                        } label: {
                            Label(signIn.starting ? "Starting…" : "Sign in with GitHub",
                                  systemImage: "person.badge.key")
                        }
                        .disabled(signIn.starting)
                    }
                    if let signInError = signIn.error {
                        Text(signInError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                    SecureField("Bearer token (or paste one manually)", text: $token)
                        .autocorrectionDisabled()
                        .noAutocapitalizationCompat()
                } header: {
                    Text("Auth")
                } footer: {
                    Text("Sign in with GitHub (your account must be on the team), or paste a session token from the OS1 server. Stored in the keychain.")
                }

                if !signIn.diagnostics.isEmpty {
                    Section("Sign-in log") {
                        ForEach(
                            Array(signIn.diagnostics.suffix(15).reversed().enumerated()),
                            id: \.offset
                        ) { _, line in
                            Text(line)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Identity") {
                    TextField("Name shown on your prompts", text: $userName)
                        .autocorrectionDisabled()
                }

                Section {
                    Button("Test connection") {
                        Task { await testConnection() }
                    }
                    if let checkResult {
                        Text(checkResult)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            #if os(iOS)
            .scrollContentBackground(.hidden)
            .background(OS1VisualStyle.background)
            #endif
            .navigationTitle("Settings")
            .inlineTitleBarCompat()
            #if os(macOS)
            .formStyle(.grouped)
            .frame(minWidth: 520, minHeight: 560)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        save()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            // No onDisappear cancel: the sign-in keeps polling after the
            // sheet closes (only the explicit Cancel button stops it).
            .onAppear { signIn.nudge() }
            .onChange(of: signIn.flow?.deviceCode) { _, deviceCode in
                copiedCode = false
                // Sign-in finished while the sheet is open — reflect the
                // minted credentials in the editable fields.
                if deviceCode == nil, ServerConfig.shared.token != token {
                    token = ServerConfig.shared.token
                    userName = ServerConfig.shared.userName
                    checkResult = nil
                }
            }
        }
    }

    private func startSignIn() {
        // The flow talks to the server, so the URL field must be applied first.
        ServerConfig.shared.baseURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        signIn.start()
    }

    private func signOut() {
        // Clearing the token also clears githubLogin (ServerConfig.token didSet).
        ServerConfig.shared.token = ""
        token = ""
    }

    private func save() {
        ServerConfig.shared.baseURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        ServerConfig.shared.userName = userName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedToken != ServerConfig.shared.token {
            // A manually pasted token isn't the GitHub sign-in's token anymore.
            ServerConfig.shared.githubLogin = ""
        }
        ServerConfig.shared.token = trimmedToken
    }

    private func testConnection() async {
        save()
        do {
            _ = try await OS1API.health()
            _ = try await OS1API.sessions()
            checkResult = "Connected — auth OK."
        } catch {
            checkResult = error.localizedDescription
        }
    }
}
