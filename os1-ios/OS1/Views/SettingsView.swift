import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var serverURL = ServerConfig.shared.baseURLString
    @State private var userName = ServerConfig.shared.userName
    @State private var token = ServerConfig.shared.token
    @State private var checkResult: String?

    // GitHub device-flow state. The poll task is retained so leaving the
    // sheet (or tapping Cancel) stops the background polling.
    @State private var deviceFlow: GitHubAuth.DeviceFlowStart?
    @State private var pollTask: Task<Void, Never>?
    @State private var signedInAs: String?
    @State private var signInError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("https://os.tella.dev", text: $serverURL)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }

                Section {
                    if let flow = deviceFlow {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Enter this code on GitHub:")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            Text(flow.userCode)
                                .font(.system(.title, design: .monospaced).bold())
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity)
                            if let url = URL(string: flow.verificationUri) {
                                Link("Open github.com/login/device", destination: url)
                            }
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Waiting for approval…")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Button("Cancel", role: .cancel) { cancelSignIn() }
                            }
                        }
                        .padding(.vertical, 4)
                    } else {
                        Button {
                            startSignIn()
                        } label: {
                            Label("Sign in with GitHub", systemImage: "person.badge.key")
                        }
                    }
                    if let signedInAs {
                        Text("Signed in as @\(signedInAs).")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if let signInError {
                        Text(signInError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                    SecureField("Bearer token (or paste one manually)", text: $token)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Auth")
                } footer: {
                    Text("Sign in with GitHub (your account must be on the team), or paste a session token from the OS1 server. Stored in the keychain.")
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
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
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
            .onDisappear { cancelSignIn() }
        }
    }

    private func startSignIn() {
        signInError = nil
        signedInAs = nil
        // The flow talks to the server, so the URL field must be applied first.
        ServerConfig.shared.baseURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        pollTask = Task {
            do {
                let flow = try await GitHubAuth.start()
                deviceFlow = flow
                let login = try await GitHubAuth.waitForAuthorization(flow)
                token = ServerConfig.shared.token
                userName = ServerConfig.shared.userName
                signedInAs = login
                checkResult = nil
            } catch is CancellationError {
                // user cancelled — nothing to report
            } catch {
                signInError = error.localizedDescription
            }
            deviceFlow = nil
            pollTask = nil
        }
    }

    private func cancelSignIn() {
        pollTask?.cancel()
        pollTask = nil
        deviceFlow = nil
    }

    private func save() {
        ServerConfig.shared.baseURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        ServerConfig.shared.userName = userName.trimmingCharacters(in: .whitespacesAndNewlines)
        ServerConfig.shared.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
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
