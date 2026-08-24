import SwiftUI

/// Settings → Keychain: the credentials you lend to your sessions.
///
/// A credential is a secret this instance holds on your behalf and never hands
/// to a model. A session asks for it, you approve, and the server proxies the
/// call with the secret injected — so what a session gets is a grant, scoped to
/// that session and expiring, not the key itself. That is why this page shows
/// three lists and no secret anywhere: what you have lent out, what is asking,
/// and what you hold.
struct KeychainSettingsView: View {
    @State private var response: KeychainResponse? = SettingsCache.value("keychain")
    @State private var loading = true
    @State private var error: String?
    @State private var showingAdd = false
    @State private var revoking: KeychainGrant?
    @State private var deleting: KeychainCredential?

    var body: some View {
        List {
            if loading, response == nil { settingsLoadingRow }
            if let error { settingsErrorRow(error) { Task { await load() } } }

            if response != nil {
                // Asks first: something is waiting on a person, and the rest of
                // the page is standing state that is not.
                if pendingAsks.isEmpty == false {
                    Section {
                        ForEach(pendingAsks, id: \.id) { ask in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(serviceName(ask.credentialId))
                                Text(ask.purpose ?? "No reason given")
                                    .font(.subheadline)
                                Text(askSummary(ask))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 2)
                        }
                    } header: {
                        Text("Waiting for you")
                    } footer: {
                        Text("Approve or decline on the question card in the session that asked.")
                    }
                }

                Section {
                    if activeGrants.isEmpty {
                        Text("Nothing lent out.").foregroundStyle(.secondary)
                    }
                    ForEach(activeGrants, id: \.id) { grant in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(serviceName(grant.credentialId))
                                Text(grant.purpose ?? "No reason given")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(grantSummary(grant))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 12)
                            Button("Revoke", role: .destructive) { revoking = grant }
                                .buttonStyle(.borderless)
                        }
                        .padding(.vertical, 2)
                    }
                } header: {
                    Text("Active grants")
                } footer: {
                    Text("A grant is a session's temporary permission to use one credential. Revoking takes it back straight away.")
                }

                Section {
                    if credentials.isEmpty {
                        Text("No credentials yet.").foregroundStyle(.secondary)
                    }
                    ForEach(credentials, id: \.id) { credential in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(credential.service ?? "Credential")
                                if let detail = credential.detail, detail.isEmpty == false {
                                    Text(detail).font(.caption).foregroundStyle(.secondary)
                                }
                                Text(credential.scopeSummary)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 12)
                            Button(role: .destructive) { deleting = credential } label: {
                                Label(
                                    "Delete \(credential.service ?? "credential")",
                                    systemImage: "trash"
                                )
                            }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.borderless)
                            #if os(iOS)
                            .frame(minWidth: 44, minHeight: 44)
                            #endif
                        }
                        .padding(.vertical, 2)
                    }
                    Button { showingAdd = true } label: {
                        Label("Add a credential", systemImage: "plus")
                    }
                } header: {
                    Text("Credentials")
                } footer: {
                    Text("The secret never reaches a model. Sessions call through this server, which injects it and scrubs it back out of the reply.")
                }
            }
        }
        .insetGroupedListCompat()
        .navigationTitle("Keychain")
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showingAdd) {
            KeychainCredentialEditor { body in await add(body) }
        }
        .alert(
            "Revoke this grant?",
            isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
            presenting: revoking
        ) { grant in
            Button("Revoke", role: .destructive) { Task { await revoke(grant) } }
            Button("Cancel", role: .cancel) {}
        } message: { grant in
            Text("The session loses access to \(serviceName(grant.credentialId)) immediately.")
        }
        .alert(
            "Delete this credential?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            presenting: deleting
        ) { credential in
            Button("Delete", role: .destructive) { Task { await delete(credential) } }
            Button("Cancel", role: .cancel) {}
        } message: { credential in
            Text("Every grant on \(credential.service ?? "this credential") stops working.")
        }
    }

    private var credentials: [KeychainCredential] {
        (response?.credentials ?? []).filter { $0.id?.isEmpty == false }
    }
    private var activeGrants: [KeychainGrant] {
        (response?.grants ?? []).filter { $0.id?.isEmpty == false && $0.isActive }
    }
    private var pendingAsks: [KeychainAsk] {
        (response?.asks ?? []).filter { $0.id?.isEmpty == false && $0.isPending }
    }

    /// A grant names a credential by id, which says nothing to a person.
    private func serviceName(_ credentialId: String?) -> String {
        credentials.first { $0.id == credentialId }?.service ?? credentialId ?? "Credential"
    }

    private func grantSummary(_ grant: KeychainGrant) -> String {
        var parts: [String] = []
        if let requestedBy = grant.requestedBy, requestedBy.isEmpty == false { parts.append(requestedBy) }
        if grant.mode == "once" { parts.append("Single use") } else if grant.mode == "standing" { parts.append("Standing") }
        if let expiry = AccountUsageReading.formatReset(grant.expiresAt) {
            parts.append(expiry.replacingOccurrences(of: "resets", with: "expires"))
        }
        return parts.joined(separator: " · ")
    }

    private func askSummary(_ ask: KeychainAsk) -> String {
        var parts: [String] = []
        if let requestedBy = ask.requestedBy, requestedBy.isEmpty == false { parts.append(requestedBy) }
        if ask.requestedMode == "once" { parts.append("Single use") } else if ask.requestedMode == "standing" { parts.append("Standing") }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        loading = true; error = nil
        do {
            let fetched = try await SettingsAPI.keychain()
            response = fetched
            SettingsCache.save("keychain", fetched)
        } catch { self.error = error.localizedDescription }
        loading = false
    }

    private func add(_ body: [String: Any]) async {
        do {
            _ = try await SettingsAPI.addKeychainCredential(body)
            showingAdd = false
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func revoke(_ grant: KeychainGrant) async {
        guard let id = grant.id else { return }
        do {
            _ = try await SettingsAPI.revokeKeychainGrant(id: id)
            await load()
        } catch { self.error = error.localizedDescription }
        revoking = nil
    }

    private func delete(_ credential: KeychainCredential) async {
        guard let id = credential.id else { return }
        do {
            _ = try await SettingsAPI.deleteKeychainCredential(id: id)
            await load()
        } catch { self.error = error.localizedDescription }
        deleting = nil
    }
}

/// Adding a credential. Service, host and secret are what the server requires;
/// the scoping fields below them are what stop one key from being a skeleton
/// key, so they sit on the same form rather than behind an "advanced" step.
private struct KeychainCredentialEditor: View {
    let onSave: ([String: Any]) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var service = ""
    @State private var host = ""
    @State private var secret = ""
    @State private var detail = ""
    @State private var header = ""
    @State private var scheme = ""
    @State private var methods = ""
    @State private var pathPrefixes = ""
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Service, e.g. vercel", text: $service)
                        .autocorrectionDisabled()
                        .noAutocapitalizationCompat()
                    TextField("Host, e.g. api.vercel.com", text: $host)
                        .urlFieldCompat()
                        .autocorrectionDisabled()
                    SecureField("Secret", text: $secret)
                        .autocorrectionDisabled()
                        .noAutocapitalizationCompat()
                    TextField("What it is for", text: $detail)
                } footer: {
                    Text("Requests are proxied to this host over https.")
                }

                Section {
                    TextField("Methods, e.g. GET, POST", text: $methods)
                        .autocorrectionDisabled()
                    TextField("Path prefixes, e.g. /v1/projects", text: $pathPrefixes)
                        .autocorrectionDisabled()
                        .noAutocapitalizationCompat()
                } header: {
                    Text("Scope")
                } footer: {
                    Text("Leave a field empty to allow all of it. Narrow scope is what keeps one approval from becoming a skeleton key.")
                }

                Section {
                    TextField("Header, default Authorization", text: $header)
                        .autocorrectionDisabled()
                    TextField("Scheme, default Bearer", text: $scheme)
                        .autocorrectionDisabled()
                } header: {
                    Text("Injection")
                } footer: {
                    Text("How the secret rides the request.")
                }
            }
            .navigationTitle("Add a credential")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        saving = true
                        Task {
                            await onSave(payload)
                            saving = false
                        }
                    }
                    .disabled(service.isEmpty || host.isEmpty || secret.isEmpty || saving)
                }
            }
            #if os(macOS)
            .formStyle(.grouped)
            #endif
        }
    }

    private var payload: [String: Any] {
        var payload: [String: Any] = ["service": service, "host": host, "secret": secret]
        if detail.isEmpty == false { payload["description"] = detail }
        let parsedMethods = split(methods).map { $0.uppercased() }
        if parsedMethods.isEmpty == false { payload["allowedMethods"] = parsedMethods }
        let parsedPrefixes = split(pathPrefixes)
        if parsedPrefixes.isEmpty == false { payload["allowedPathPrefixes"] = parsedPrefixes }
        var injection: [String: Any] = [:]
        if header.isEmpty == false { injection["header"] = header }
        if scheme.isEmpty == false { injection["scheme"] = scheme }
        if injection.isEmpty == false { payload["injection"] = injection }
        return payload
    }

    private func split(_ value: String) -> [String] {
        value
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.isEmpty == false }
    }
}
