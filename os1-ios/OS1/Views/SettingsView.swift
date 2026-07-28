import SwiftUI

struct SettingsView: View {
    var onOpenSession: ((String) -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var config = ServerConfig.shared
    @State private var showingConnection = !ServerConfig.shared.isConfigured
    @State private var serverURL = ServerConfig.shared.baseURLString
    @State private var userName = ServerConfig.shared.userName
    @State private var token = ServerConfig.shared.token
    @State private var checkResult: String?
    @State private var copiedCode = false

    // Device-flow state outlives this sheet while GitHub is open.
    private var signIn: GitHubSignIn { .shared }

    private var signedInLogin: String? {
        let login = config.githubLogin
        return login.isEmpty || token.isEmpty ? nil : login
    }

    var body: some View {
        NavigationStack {
            Group {
                if showingConnection || !config.isConfigured {
                    connectionForm
                } else {
                    EmbeddedSettingsView(
                        onAuthenticationFailure: {
                            config.token = ""
                            token = ""
                            showingConnection = true
                            checkResult = "Your session expired. Sign in again to open Settings."
                        },
                        onOpenSession: { id in
                            dismiss()
                            onOpenSession?(id)
                        }
                    )
                }
            }
            .navigationTitle(showingConnection || !config.isConfigured ? "Connection" : "")
            .inlineTitleBarCompat()
            #if os(macOS)
            .frame(minWidth: 520, minHeight: 560)
            #endif
            .toolbar { toolbar }
            // No onDisappear cancellation: device-flow polling deliberately
            // survives closing Settings while GitHub is in the foreground.
            .onAppear { signIn.nudge() }
            .onChange(of: signIn.flow?.deviceCode) { _, deviceCode in
                copiedCode = false
                if deviceCode == nil, config.token != token {
                    token = config.token
                    userName = config.userName
                    checkResult = nil
                    if config.isConfigured { showingConnection = false }
                }
            }
        }
    }

    private var connectionForm: some View {
        Form {
            Section("Server") {
                TextField("https://os.tella.dev", text: $serverURL)
                    .urlFieldCompat()
                    .autocorrectionDisabled()
            }

            Section {
                if let flow = signIn.flow {
                    signInFlow(flow)
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
                        Label(
                            signIn.starting ? "Starting…" : "Sign in with GitHub",
                            systemImage: "person.badge.key"
                        )
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
                Text("Sign in with GitHub, or paste a session token. Stored in the keychain.")
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
        #else
        .formStyle(.grouped)
        #endif
    }

    @ViewBuilder
    private func signInFlow(_ flow: GitHubAuth.DeviceFlowStart) -> some View {
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
        // Form rows otherwise merge every button into one tap target.
        .buttonStyle(.borderless)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if showingConnection || !config.isConfigured {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    save()
                    if config.isConfigured { showingConnection = false }
                }
            }
            ToolbarItem(placement: .cancellationAction) {
                Button(config.isConfigured ? "Back" : "Cancel") {
                    if config.isConfigured {
                        showingConnection = false
                    } else {
                        dismiss()
                    }
                }
            }
        } else {
            ToolbarItem(placement: .topLeadingCompat) {
                Button("Connection") { showingConnection = true }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
    }

    private func startSignIn() {
        config.baseURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        signIn.start()
    }

    private func signOut() {
        Task {
            try? await OS1API.logout()
            config.token = ""
            token = ""
            showingConnection = true
        }
    }

    private func save() {
        config.baseURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        config.userName = userName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedToken != config.token { config.githubLogin = "" }
        config.token = trimmedToken
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
