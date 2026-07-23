import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var serverURL = ServerConfig.shared.baseURLString
    @State private var userName = ServerConfig.shared.userName
    @State private var token = ServerConfig.shared.token
    @State private var checkResult: String?

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
                    SecureField("Bearer token", text: $token)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Auth")
                } footer: {
                    Text("Paste a session token from the OS1 server (web sign-in mints one; it is the opensession_auth cookie value). Stored in the keychain.")
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
        }
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
