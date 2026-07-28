import SwiftUI

// Native personal settings use the same server preference keys as the web app
// where a preference follows a person between devices. Device alerts stay local.

struct NotificationsSettingsView: View {
    @AppStorage("os1.notifications.pushAlerts") private var pushAlerts = false
    @AppStorage("os1.notifications.completionSound") private var completionSound = "default"
    @AppStorage("os1.notifications.whenToNotify") private var whenToNotify = "background"
    @AppStorage("os1.notifications.needsInput") private var needsInputAlerts = true
    @AppStorage("os1.notifications.runComplete") private var runCompleteAlerts = true

    var body: some View {
        Form {
            Section("Alerts") {
                Toggle("Push alerts on this device", isOn: $pushAlerts)
                Picker("Completion sound", selection: $completionSound) {
                    Text("Default").tag("default")
                    Text("None").tag("none")
                }
                Picker("When to notify", selection: $whenToNotify) {
                    Text("Always").tag("always")
                    Text("When OS1 is in the background").tag("background")
                    Text("Never").tag("never")
                }
            } footer: {
                Text("These alert preferences apply only to this native OS1 app and device.")
            }

            Section("Events") {
                Toggle("Session needs input", isOn: $needsInputAlerts)
                Toggle("Session run completes", isOn: $runCompleteAlerts)
            }
        }
        .navigationTitle("Notifications")
        .onChange(of: pushAlerts) { _, enabled in
            guard enabled else { return }
            Task {
                if !(await NativeNotifications.requestAuthorization()) {
                    pushAlerts = false
                }
            }
        }
    }
}

struct ComposerSettingsView: View {
    @AppStorage("os1.composer.defaultModel") private var defaultModel = ""
    @AppStorage("os1.composer.sendKey") private var nativeSendKey = "enter"
    @AppStorage("os1.composer.busySend") private var nativeBusySend = "queue"
    @AppStorage("os1.composer.busySendMod") private var nativeBusySendMod = "steer"

    @State private var models: [SettingsModelOption] = []
    @State private var sendKey = "enter"
    @State private var busySend = "queue"
    @State private var busySendMod = "steer"
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    @State private var savedMessage: String?

    private let user = ServerConfig.shared.userName

    var body: some View {
        Form {
            if loading {
                Section { ProgressView("Loading composer preferences…") }
            } else {
                if let error {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                        Button("Try again") { Task { await load() } }
                    }
                }

                Section("New sessions") {
                    Picker("Default model", selection: $defaultModel) {
                        Text("No preference").tag("")
                        ForEach(models.filter { $0.id?.isEmpty == false }, id: \.id) { model in
                            Text(model.label ?? model.id ?? "Model").tag(model.id ?? "")
                        }
                    }
                } footer: {
                    Text("New sessions use this model when available. No preference uses the workspace default.")
                }

                Section("Sending") {
                    #if os(macOS)
                    Picker("Send messages with", selection: $sendKey) {
                        Text("Enter").tag("enter")
                        Text("Command/Control-Enter").tag("mod-enter")
                    }
                    Picker("Send button while busy", selection: $busySend) {
                        Text("Queue for later").tag("queue")
                        Text("Steer the current run").tag("steer")
                    }
                    if sendKey == "enter" {
                        Picker("Command/Control-Enter while busy", selection: $busySendMod) {
                            Text("Queue for later").tag("queue")
                            Text("Steer the current run").tag("steer")
                        }
                    }
                    #else
                    LabeledContent("Send messages with", value: "Return")
                    #endif
                }

                Section {
                    Button(saving ? "Saving…" : "Save composer preferences") {
                        Task { await save() }
                    }
                    .disabled(saving)
                    if let savedMessage {
                        Text(savedMessage)
                            .foregroundStyle(.green)
                    }
                }
            }
        }
        .navigationTitle("Composer")
        .task { await load() }
    }

    private func load() async {
        loading = true
        error = nil
        do {
            async let fetchedPrefs = SettingsAPI.uiPrefs(user: user)
            async let fetchedCatalog = SettingsAPI.modelCatalog()
            let (prefs, catalog) = try await (fetchedPrefs, fetchedCatalog)
            models = catalog.models ?? []
            defaultModel = prefs["default-model"] ?? defaultModel
            sendKey = prefs["send-key"] == "mod-enter" ? "mod-enter" : "enter"
            busySend = prefs["busy-send"] == "steer" ? "steer" : "queue"
            busySendMod = prefs["busy-send-mod"] == "queue" ? "queue" : "steer"
            #if os(macOS)
            nativeSendKey = sendKey
            #endif
            nativeBusySend = busySend
            nativeBusySendMod = busySendMod
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func save() async {
        saving = true
        error = nil
        savedMessage = nil
        do {
            let prefs = try await SettingsAPI.updateUiPrefs(user: user, prefs: [
                "default-model": defaultModel,
                "send-key": sendKey,
                "busy-send": busySend,
                "busy-send-mod": busySendMod,
            ])
            defaultModel = prefs["default-model"] ?? defaultModel
            #if os(macOS)
            nativeSendKey = sendKey
            #endif
            nativeBusySend = busySend
            nativeBusySendMod = busySendMod
            savedMessage = "Composer preferences saved."
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
    }
}

struct AppearanceSettingsView: View {
    @AppStorage("os1.appearance") private var appearance = "system"
    @AppStorage("os1.appearance.turnActivity") private var nativeTurnActivity = "auto"

    @State private var turnActivity = "auto"
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    @State private var savedMessage: String?

    private let user = ServerConfig.shared.userName

    var body: some View {
        Form {
            Section("Theme") {
                Picker("Appearance", selection: $appearance) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
            } footer: {
                Text("The selected native appearance is stored on this device.")
            }

            Section("Chat") {
                if loading {
                    ProgressView("Loading chat preferences…")
                } else {
                    Picker("Tool calls and messages", selection: $turnActivity) {
                        Text("Expand while running").tag("auto")
                        Text("Always expanded").tag("expanded")
                        Text("Always collapsed").tag("collapsed")
                    }
                    Button(saving ? "Saving…" : "Save chat preference") {
                        Task { await saveTurnActivity() }
                    }
                    .disabled(saving)
                }
            } footer: {
                Text("Controls how a turn's working activity is folded in chat. Sidebar settings are not shown because the native app has no web sidebar.")
            }

            if let error {
                Section {
                    Text(error).foregroundStyle(.red)
                    Button("Try again") { Task { await load() } }
                }
            }
            if let savedMessage {
                Section { Text(savedMessage).foregroundStyle(.green) }
            }
        }
        .navigationTitle("Appearance")
        .task { await load() }
    }

    private func load() async {
        loading = true
        error = nil
        do {
            let prefs = try await SettingsAPI.uiPrefs(user: user)
            if ["auto", "expanded", "collapsed"].contains(prefs["turn-activity"]) {
                turnActivity = prefs["turn-activity"] ?? "auto"
                nativeTurnActivity = turnActivity
            }
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func saveTurnActivity() async {
        saving = true
        error = nil
        savedMessage = nil
        do {
            _ = try await SettingsAPI.updateUiPrefs(user: user, prefs: ["turn-activity": turnActivity])
            nativeTurnActivity = turnActivity
            savedMessage = "Chat preference saved."
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
    }
}

struct PersonalPromptSettingsView: View {
    @State private var prompt = ""
    @State private var savedPrompt = ""
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    @State private var savedMessage: String?

    private let user = ServerConfig.shared.userName

    var body: some View {
        Form {
            if loading {
                Section { ProgressView("Loading personal prompt…") }
            } else {
                Section {
                    Text("Standing instructions are added to every interactive session you start. They follow your identity across devices and are not used for automations.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    TextEditor(text: $prompt)
                        .frame(minHeight: 180)
                } header: {
                    Text("Instructions")
                } footer: {
                    Text("Leave this empty to turn off personal instructions.")
                }

                Section {
                    Button(saving ? "Saving…" : "Save personal prompt") {
                        Task { await save() }
                    }
                    .disabled(saving || prompt == savedPrompt)
                    Button("Clear personal prompt", role: .destructive) {
                        prompt = ""
                        Task { await save() }
                    }
                    .disabled(saving || prompt.isEmpty)
                    if prompt != savedPrompt, !saving {
                        Text("Unsaved changes")
                            .foregroundStyle(.secondary)
                    }
                    if let savedMessage {
                        Text(savedMessage).foregroundStyle(.green)
                    }
                }
            }

            if let error {
                Section {
                    Text(error).foregroundStyle(.red)
                    Button("Try again") { Task { await load() } }
                }
            }
        }
        .navigationTitle("Personal prompt")
        .task { await load() }
    }

    private func load() async {
        loading = true
        error = nil
        do {
            let result = try await SettingsAPI.personalPrompt(user: user)
            prompt = result
            savedPrompt = result
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func save() async {
        saving = true
        error = nil
        savedMessage = nil
        do {
            let result = try await SettingsAPI.setPersonalPrompt(user: user, prompt: prompt)
            prompt = result
            savedPrompt = result
            savedMessage = result.isEmpty ? "Personal prompt cleared." : "Personal prompt saved."
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
    }
}
