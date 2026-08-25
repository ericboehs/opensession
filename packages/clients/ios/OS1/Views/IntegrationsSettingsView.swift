import SwiftUI

/// Settings → Integrations: the tools this instance is wired into.
///
/// What a phone can do here is manage what is already connected: read each
/// integration's state, see which credentials it is still missing, and switch
/// one on or off. What it deliberately cannot do is type the credentials. An
/// API key is pasted from a dashboard on another screen and is unreadable
/// once stored, so a mistake stays invisible until something quietly stops
/// working. Those are entered on the web, and the footer says where.
///
/// It reads the same `/api/setup/status` snapshot as the Setup checklist,
/// through the same cache, so opening either screen after the other shows the
/// state it already had rather than a spinner.
struct IntegrationsSettingsView: View {
    @State private var status: OS1API.SetupStatus? = SettingsCache.value("setup-status")
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        List {
            if loading, status == nil {
                settingsLoadingRow
            } else {
                if let error { settingsErrorRow(error) { Task { await load() } } }
                Section {
                    let items = status?.integrations ?? []
                    if items.isEmpty, status != nil {
                        Text("This instance offers no integrations.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(items) { integration in
                        NavigationLink {
                            IntegrationDetailView(integration: integration) { updated in
                                replace(updated)
                            }
                        } label: {
                            IntegrationRow(integration: integration)
                        }
                    }
                } footer: {
                    Text("Credentials stay on this server and are never shown again, so they are entered on the web at \(webHost).")
                }

                if let github = status?.github {
                    Section {
                        NavigationLink {
                            GithubSignInDetailView(github: github) { updated in
                                replace(github: updated)
                            }
                        } label: {
                            GithubSignInRow(github: github)
                        }
                    } header: {
                        Text("Sign-in")
                    } footer: {
                        Text("With it on, a teammate who connects their account opens pull requests as themselves instead of as the workspace account.")
                    }
                }
            }
        }
        .insetGroupedListCompat()
        .navigationTitle("Integrations")
        .task { await load() }
        .refreshable { await load() }
    }

    /// Where the web UI lives, for the part this screen deliberately leaves to
    /// it. The server's own `publicBaseUrl` rather than the address this
    /// device dials, which on a tunnelled or tailnet setup is not the one a
    /// teammate would type into a browser.
    private var webHost: String {
        let raw = status?.publicBaseUrl ?? ServerConfig.shared.baseURLString
        if let host = URL(string: raw)?.host, !host.isEmpty { return host }
        return raw.isEmpty ? "the web UI" : raw
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let fetched = try await OS1API.setupStatus()
            status = fetched
            SettingsCache.save("setup-status", fetched)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Take a detail screen's answer back into the list, so returning to it
    /// shows what was just changed without waiting for a refetch.
    private func replace(_ updated: IntegrationSettings) {
        guard var current = status else { return }
        current.integrations = (current.integrations ?? []).map {
            $0.id == updated.id ? updated : $0
        }
        status = current
        SettingsCache.save("setup-status", current)
    }

    private func replace(github updated: GithubSignInSettings) {
        guard var current = status else { return }
        current.github = updated
        status = current
        SettingsCache.save("setup-status", current)
    }
}

// MARK: - Rows

private struct IntegrationRow: View {
    let integration: IntegrationSettings

    var body: some View {
        let state = IntegrationRules.state(integration)
        HStack(spacing: 12) {
            BrandTile(name: integration.id, size: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(integration.title)
                    .foregroundStyle(OS1VisualStyle.text)
                Text(IntegrationRules.description(integration))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            StateChip(tone: state.tone, label: state.label)
        }
        .padding(.vertical, 2)
    }
}

private struct GithubSignInRow: View {
    let github: GithubSignInSettings

    var body: some View {
        let state = IntegrationRules.githubState(github)
        HStack(spacing: 12) {
            BrandTile(name: "github", size: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text("GitHub sign-in")
                    .foregroundStyle(OS1VisualStyle.text)
                Text(IntegrationRules.githubDetail(github))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            StateChip(tone: state.tone, label: state.label)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - One integration

private struct IntegrationDetailView: View {
    @State var integration: IntegrationSettings
    let onUpdated: (IntegrationSettings) -> Void

    @Environment(\.openURL) private var openURL
    @State private var saving = false
    @State private var error: String?

    init(integration: IntegrationSettings, onUpdated: @escaping (IntegrationSettings) -> Void) {
        _integration = State(initialValue: integration)
        self.onUpdated = onUpdated
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    BrandTile(name: integration.id, size: 40)
                    Text(IntegrationRules.description(integration))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }

            Section {
                if IntegrationRules.canToggle(integration) {
                    Toggle("Enabled", isOn: Binding(
                        get: { integration.enabled ?? false },
                        set: { next in Task { await setEnabled(next) } }
                    ))
                    .disabled(saving)
                } else {
                    let state = IntegrationRules.state(integration)
                    LabeledContent("Status") {
                        StateChip(tone: state.tone, label: state.label)
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red).font(.footnote)
                }
            } footer: {
                Text(switchFooter)
            }

            let env = integration.env ?? []
            if !env.isEmpty {
                Section {
                    ForEach(env) { variable in
                        EnvRow(variable: variable)
                    }
                } header: {
                    Text("Credentials")
                } footer: {
                    Text("A stored credential is never shown again, so these say whether one is set, not what it is.")
                }
            }

            let links = allLinks
            if !links.isEmpty {
                Section {
                    ForEach(links) { link in
                        Button {
                            if let url = link.url.flatMap(URL.init(string:)) { openURL(url) }
                        } label: {
                            Label(link.label ?? "Open", systemImage: "arrow.up.forward.app")
                        }
                    }
                } header: {
                    Text("Reference")
                }
            }
        }
        .insetGroupedListCompat()
        .navigationTitle(integration.title)
        .inlineTitleBarCompat()
    }

    /// The doc first, then whatever the registry lists — the same order the
    /// web's setup dialog puts them in.
    private var allLinks: [IntegrationLink] {
        var links: [IntegrationLink] = []
        if let doc = integration.doc, !doc.isEmpty {
            links.append(IntegrationLink(label: "Documentation", url: doc))
        }
        links.append(contentsOf: (integration.links ?? []).filter { $0.url?.isEmpty == false })
        return links
    }

    private var switchFooter: String {
        // Code storage is not a flag: it is switched by connecting a host,
        // which is a credential exchange and stays on the web.
        if integration.id == "codestorage" {
            return "Code storage is connected on the web, not switched on here."
        }
        if !IntegrationRules.canToggle(integration) {
            let missing = (integration.missingRequired ?? []).joined(separator: ", ")
            return missing.isEmpty
                ? "Add its credentials on the web before turning it on."
                : "Add \(missing) on the web before turning it on."
        }
        return (integration.enabled ?? false)
            ? "Turning it off stops sessions reading or replying there. It takes effect when the server restarts."
            : "It takes effect when the server restarts."
    }

    private func setEnabled(_ next: Bool) async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        do {
            let response = try await SettingsAPI.setIntegrationEnabled(
                id: integration.id,
                enabled: next
            )
            // The server's own snapshot, not the value that was sent: it
            // re-reads the env file, so this is also where a credential that
            // landed since the last refresh shows up.
            if let updated = response.integration {
                integration = updated
                onUpdated(updated)
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct EnvRow: View {
    let variable: IntegrationEnvVar

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(variable.name)
                    .font(.subheadline.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                StateChip(tone: state.tone, label: state.label)
            }
            if let detail = variable.detail, !detail.isEmpty {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    /// Three states, not two: an optional key nobody set is not a problem,
    /// and colouring it like a missing required one would make every
    /// integration look half-finished.
    private var state: (tone: SetupTone, label: String) {
        if variable.present ?? false { return (.on, "Set") }
        return (variable.required ?? false) ? (.warn, "Missing") : (.off, "Not set")
    }
}

// MARK: - GitHub sign-in

private struct GithubSignInDetailView: View {
    @State var github: GithubSignInSettings
    let onUpdated: (GithubSignInSettings) -> Void

    @Environment(\.openURL) private var openURL
    @State private var saving = false
    @State private var error: String?

    init(github: GithubSignInSettings, onUpdated: @escaping (GithubSignInSettings) -> Void) {
        _github = State(initialValue: github)
        self.onUpdated = onUpdated
    }

    var body: some View {
        List {
            Section {
                Toggle("GitHub sign-in", isOn: Binding(
                    get: { github.userPrAuth ?? false },
                    set: { next in Task { await setEnabled(next) } }
                ))
                // The switch needs an app to sign into. Without a client id
                // it would store a preference that nothing can act on.
                .disabled(saving || !(github.clientIdConfigured ?? false))
                if let error {
                    Text(error).foregroundStyle(.red).font(.footnote)
                }
            } footer: {
                Text(footer)
            }

            if let create = github.appCreateUrl, !create.isEmpty {
                Section {
                    Button {
                        if let url = URL(string: create) { openURL(url) }
                    } label: {
                        Label("Create GitHub App", systemImage: "arrow.up.forward.app")
                    }
                } footer: {
                    Text(
                        "Configure the App details on the web under Settings → Integrations, and choose the sign-in method under Settings → Authentication."
                    )
                }
            }
        }
        .insetGroupedListCompat()
        .navigationTitle("GitHub sign-in")
        .inlineTitleBarCompat()
    }

    private var footer: String {
        guard github.clientIdConfigured ?? false else {
            return "It needs a GitHub App first. Create one, then add its client id on the web."
        }
        // The Device Flow switch is GitHub's, so this cannot report whether it
        // is on. It is also the only way in, so the requirement is said here
        // rather than discovered by a teammate who cannot sign in.
        let secret = (github.clientSecretConfigured ?? false)
            ? "Teammates connect their own account under Personal → Account."
            : "Add a client secret on the web so teammates' tokens renew."
        return "Signing in is a device code, so the app needs Device Flow enabled on GitHub. "
            + secret
            + " Takes effect when the server restarts."
    }

    private func setEnabled(_ next: Bool) async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        do {
            let response = try await SettingsAPI.setGithubSignIn(enabled: next)
            if let updated = response.github {
                github = updated
                onUpdated(updated)
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
