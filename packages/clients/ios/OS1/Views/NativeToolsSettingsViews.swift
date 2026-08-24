import SwiftUI

// Native settings for operational tools. These views intentionally use only
// SettingsAPI so they can be embedded in the existing Settings navigation.

func automationFormBody(
    isEditing: Bool,
    name: String,
    prompt: String,
    schedule: String,
    mode: String,
    model: String,
    owner: String,
    workspaceId: String,
    mcpAccess: String,
    mcpServers: String,
    createdBy: String
) -> [String: Any] {
    let servers = mcpServers
        .split(separator: ",")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
    let trimmedOwner = owner.trimmingCharacters(in: .whitespacesAndNewlines)
    var body: [String: Any] = [
        "name": name,
        "prompt": prompt,
        "schedule": schedule,
        "mode": mode,
        "model": model,
    ]
    if isEditing {
        // Empty strings deliberately clear these optional fields. Everything
        // outside this form stays absent, so the server's PATCH-like PUT keeps it.
        body["owner"] = trimmedOwner
        body["workspaceId"] = workspaceId
    } else {
        body["createdBy"] = createdBy
        if !trimmedOwner.isEmpty { body["owner"] = trimmedOwner }
        if !workspaceId.isEmpty { body["workspaceId"] = workspaceId }
    }
    if mcpAccess == "none" { body["mcpServers"] = [] }
    if mcpAccess == "selected" { body["mcpServers"] = servers }
    if mcpAccess == "all", isEditing { body["mcpServers"] = NSNull() }
    return body
}

struct AutomationSettingsView: View {
    var initialAutomationId: String? = nil
    @State private var automations: [Automation] = SettingsCache.value("automations") ?? []
    @State private var loading = false
    @State private var error: String?
    @State private var showingEditor = false
    @State private var selectedAutomationId: String?
    @State private var openedInitialAutomation = false

    private var records: [Automation] { automations.filter { $0.id != nil } }
    private var selectedAutomation: Automation? {
        records.first { $0.id == selectedAutomationId }
    }

    var body: some View {
        List {
            if loading && records.isEmpty {
                ProgressView("Loading automations…")
            } else if let error, records.isEmpty {
                ContentUnavailableView("Unable to Load", systemImage: "exclamationmark.triangle", description: Text(error))
            } else if records.isEmpty {
                ContentUnavailableView("No Automations", systemImage: "clock.arrow.circlepath", description: Text("Create a scheduled or manual routine."))
            } else {
                ForEach(records, id: \.id) { automation in
                    if let id = automation.id {
                        NavigationLink {
                            AutomationDetailView(automation: automation, onChanged: load)
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                HStack {
                                    Text(automation.name ?? "Unnamed automation")
                                    Spacer()
                                    StatusBadge(text: automation.enabled == false ? "Disabled" : (automation.isRunning == true ? "Running" : "Enabled"))
                                }
                                Text(automation.schedule?.isEmpty == false ? automation.schedule! : "Manual")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                if let model = automation.model, !model.isEmpty {
                                    Text(model).font(.caption).foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Automations")
        .toolbar { Button { showingEditor = true } label: { Label("New Automation", systemImage: "plus") } }
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showingEditor) {
            NavigationStack { AutomationEditorView { body in await create(body) } }
        }
        .navigationDestination(
            isPresented: Binding(
                get: { selectedAutomationId != nil },
                set: { if !$0 { selectedAutomationId = nil } }
            )
        ) {
            if let selectedAutomation {
                AutomationDetailView(automation: selectedAutomation, onChanged: load)
            } else {
                ContentUnavailableView(
                    "Automation not found",
                    systemImage: "clock.badge.questionmark",
                    description: Text(selectedAutomationId ?? "")
                )
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        if !openedInitialAutomation, let initialAutomationId {
            openedInitialAutomation = true
            selectedAutomationId = initialAutomationId
        }
        do {
            automations = try await SettingsAPI.automations()
            error = nil
            SettingsCache.save("automations", automations)
        }
        catch { self.error = error.localizedDescription }
    }

    private func create(_ body: [String: Any]) async -> String? {
        do { _ = try await SettingsAPI.createAutomation(body); await load(); return nil }
        catch { return error.localizedDescription }
    }

    private func delete(_ id: String) async {
        do { _ = try await SettingsAPI.deleteAutomation(id: id); await load() }
        catch { self.error = error.localizedDescription }
    }
}

private struct AutomationDetailView: View {
    @Environment(\.dismiss) private var dismiss
    let automation: Automation
    let onChanged: () async -> Void
    @State private var current: Automation
    @State private var showingEditor = false
    @State private var confirmingDelete = false
    @State private var error: String?
    @State private var workspaces: [OS1API.WorkspaceSummary] = []

    init(automation: Automation, onChanged: @escaping () async -> Void) {
        self.automation = automation
        self.onChanged = onChanged
        _current = State(initialValue: automation)
    }

    var body: some View {
        Form {
            Section("Status") {
                LabeledContent("State", value: current.isRunning == true ? "Running" : (current.enabled == false ? "Disabled" : "Enabled"))
                Toggle("Enabled", isOn: Binding(get: { current.enabled ?? true }, set: { enabled in Task { await setEnabled(enabled) } }))
                Button("Run Now") { Task { await runNow() } }.disabled(current.isRunning == true)
            }
            Section("Prompt") { Text(current.prompt ?? "No prompt") .textSelection(.enabled) }
            Section("Configuration") {
                LabeledContent("Schedule", value: current.schedule?.isEmpty == false ? current.schedule! : "Manual")
                LabeledContent("Mode", value: current.mode ?? "ask")
                LabeledContent("Owner", value: current.owner?.isEmpty == false ? current.owner! : "Unassigned")
                LabeledContent("Workspace", value: workspaceLabel)
                if let model = current.model { LabeledContent("Model", value: model) }
                if let servers = current.mcpServers, !servers.isEmpty { LabeledContent("MCP servers", value: servers.joined(separator: ", ")) }
            }
            if let runs = current.runs?.filter({ $0.id != nil }), !runs.isEmpty {
                Section("Recent Runs") {
                    ForEach(runs, id: \.id) { run in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(run.status ?? "Unknown").font(.subheadline.weight(.medium))
                            Text(run.at ?? run.sessionId ?? "No timestamp").font(.caption).foregroundStyle(.secondary)
                            if let error = run.error, !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
                        }
                    }
                }
            }
            if let error { Section { Text(error).foregroundStyle(.red) } }
            Section { Button("Delete Automation", role: .destructive) { confirmingDelete = true } }
        }
        .navigationTitle(current.name ?? "Automation")
        .toolbar { Button("Edit") { showingEditor = true } }
        .sheet(isPresented: $showingEditor) {
            NavigationStack { AutomationEditorView(automation: current) { body in await update(body) } }
        }
        .confirmationDialog("Delete this automation?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await delete() } }
        } message: { Text("This permanently removes its configuration and schedule.") }
        .task { workspaces = (try? await OS1API.workspaces()) ?? [] }
    }

    private var workspaceLabel: String {
        guard let id = current.workspaceId, !id.isEmpty else { return "None" }
        return workspaces.first { $0.id == id }?.name ?? id
    }

    private func update(_ body: [String: Any]) async -> String? {
        guard let id = current.id else { return "Automation ID is missing." }
        do { var updated = try await SettingsAPI.updateAutomation(id: id, patch: body); updated.isRunning = current.isRunning; current = updated; await onChanged(); return nil }
        catch { self.error = error.localizedDescription; return error.localizedDescription }
    }
    private func setEnabled(_ enabled: Bool) async { _ = await update(["enabled": enabled]) }
    private func runNow() async {
        guard let id = current.id else { return }
        do { _ = try await SettingsAPI.runAutomation(id: id); await onChanged() }
        catch { self.error = error.localizedDescription }
    }
    private func delete() async {
        guard let id = current.id else { return }
        do { _ = try await SettingsAPI.deleteAutomation(id: id); await onChanged(); dismiss() }
        catch { self.error = error.localizedDescription }
    }
}

private struct AutomationEditorView: View {
    let automation: Automation?
    let save: ([String: Any]) async -> String?
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var prompt: String
    @State private var schedule: String
    @State private var mode: String
    @State private var model: String
    @State private var owner: String
    @State private var workspaceId: String
    @State private var mcpAccess: String
    @State private var mcpServers: String
    @State private var workspaces: [OS1API.WorkspaceSummary] = []
    @State private var saving = false
    @State private var error: String?

    init(automation: Automation? = nil, save: @escaping ([String: Any]) async -> String?) {
        self.automation = automation
        self.save = save
        _name = State(initialValue: automation?.name ?? "")
        _prompt = State(initialValue: automation?.prompt ?? "")
        _schedule = State(initialValue: automation?.schedule ?? "")
        _mode = State(initialValue: automation?.mode ?? "ask")
        _model = State(initialValue: automation?.model ?? "")
        _owner = State(initialValue: automation?.owner ?? "")
        _workspaceId = State(initialValue: automation?.workspaceId ?? "")
        _mcpAccess = State(initialValue: automation?.mcpServers == nil ? "all" : (automation?.mcpServers?.isEmpty == true ? "none" : "selected"))
        _mcpServers = State(initialValue: automation?.mcpServers?.joined(separator: ", ") ?? "")
    }

    var body: some View {
        Form {
            Section("Automation") {
                TextField("Name", text: $name)
                TextEditor(text: $prompt).frame(minHeight: 140).overlay(alignment: .topLeading) { if prompt.isEmpty { Text("Prompt").foregroundStyle(.tertiary).padding(.top, 8).allowsHitTesting(false) } }
            }
            Section("Schedule") { TextField("Cron expression (leave blank for manual)", text: $schedule).fontDesign(.monospaced) }
            Section("Responsibility") {
                TextField("Owner (optional)", text: $owner)
                    .autocorrectionDisabled()
                Text("Who reviews what it does. It appears in their sidebar.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Picker("Workspace", selection: $workspaceId) {
                    Text("No workspace").tag("")
                    if !workspaceId.isEmpty, !workspaces.contains(where: { $0.id == workspaceId }) {
                        Text(workspaceId).tag(workspaceId)
                    }
                    ForEach(workspaces, id: \.id) { workspace in
                        Text(workspace.name).tag(workspace.id)
                    }
                }
                Text("Files the automation under a workspace. Its runs stay in Automations.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Execution") {
                Picker("Mode", selection: $mode) { Text("Ask").tag("ask"); Text("Code").tag("code") }.pickerStyle(.segmented)
                TextField("Model (optional)", text: $model).autocorrectionDisabled().noAutocapitalizationCompat()
                Picker("MCP access", selection: $mcpAccess) {
                    Text("All configured servers").tag("all")
                    Text("No MCP servers").tag("none")
                    Text("Selected servers").tag("selected")
                }
                if mcpAccess == "selected" {
                    TextField("MCP servers (comma separated)", text: $mcpServers).autocorrectionDisabled().noAutocapitalizationCompat()
                }
            }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }
        .navigationTitle(automation == nil ? "New Automation" : "Edit Automation")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) { Button(saving ? "Saving…" : "Save") { Task { await submit() } }.disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
        }
        .task { workspaces = (try? await OS1API.workspaces()) ?? [] }
    }
    private func submit() async {
        saving = true; defer { saving = false }
        let body = automationFormBody(
            isEditing: automation != nil,
            name: name,
            prompt: prompt,
            schedule: schedule,
            mode: mode,
            model: model,
            owner: owner,
            workspaceId: workspaceId,
            mcpAccess: mcpAccess,
            mcpServers: mcpServers,
            createdBy: ServerConfig.shared.userName
        )
        if let message = await save(body) { error = message } else { dismiss() }
    }
}

struct GoalSettingsView: View {
    @State private var goals: [Goal] = SettingsCache.value("goals") ?? []
    @State private var loading = false
    @State private var error: String?
    @State private var showingEditor = false
    private var records: [Goal] { goals.filter { $0.id != nil } }

    var body: some View {
        List {
            if loading && records.isEmpty { ProgressView("Loading goals…") }
            else if let error, records.isEmpty { ContentUnavailableView("Unable to Load", systemImage: "exclamationmark.triangle", description: Text(error)) }
            else if records.isEmpty { ContentUnavailableView("No Goals", systemImage: "target", description: Text("Create a long-running mission.")) }
            else { ForEach(records, id: \.id) { goal in
                NavigationLink { GoalDetailView(goal: goal, onChanged: load) } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack { Text(goal.name ?? "Unnamed goal"); Spacer(); StatusBadge(text: goal.status ?? "active") }
                        Text(goal.phase ?? "No phase").font(.footnote).foregroundStyle(.secondary)
                        Text("Wakes: \(goal.wakeCount ?? 0) · next \(goal.nextWakeAt ?? "not scheduled")").font(.caption).foregroundStyle(.tertiary)
                    }
                }
            } }
        }
        .navigationTitle("Goals")
        .toolbar { Button { showingEditor = true } label: { Label("New Goal", systemImage: "plus") } }
        .task { await load() }.refreshable { await load() }
        .sheet(isPresented: $showingEditor) { NavigationStack { GoalEditorView { body in await create(body) } } }
    }
    private func load() async { loading = true; defer { loading = false }; do { goals = try await SettingsAPI.goals(); error = nil; SettingsCache.save("goals", goals) } catch { self.error = error.localizedDescription } }
    private func create(_ body: [String: Any]) async -> String? { do { _ = try await SettingsAPI.createGoal(body); await load(); return nil } catch { return error.localizedDescription } }
}

private struct GoalDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var current: Goal
    let onChanged: () async -> Void
    @State private var showingEditor = false
    @State private var confirmingDelete = false
    @State private var error: String?
    init(goal: Goal, onChanged: @escaping () async -> Void) { _current = State(initialValue: goal); self.onChanged = onChanged }
    var body: some View {
        Form {
            Section("Status") {
                LabeledContent("State", value: current.status ?? "active")
                LabeledContent("Phase", value: current.phase ?? "Not set")
                LabeledContent("Wake count", value: String(current.wakeCount ?? 0))
                if current.status == "active" {
                    Button("Wake Now") { Task { await wake() } }.disabled(current.isRunning == true)
                }
                if current.status == "active" { Button("Pause") { Task { await pause() } } } else { Button("Resume") { Task { await resume() } } }
            }
            Section("Mission") { Text(current.mission ?? "No mission").textSelection(.enabled) }
            Section("Configuration") {
                LabeledContent("Mode", value: current.mode ?? "ask")
                if let repo = current.repo { LabeledContent("Repository", value: repo) }
                if let model = current.model { LabeledContent("Model", value: model) }
                LabeledContent("Cadence", value: "Every \(current.minWakeMinutes ?? 30) min")
                if let max = current.maxWakes { LabeledContent("Maximum wakes", value: String(max)) }
                if let next = current.nextWakeAt { LabeledContent("Next wake", value: next) }
            }
            if let ledger = current.ledger, !ledger.isEmpty { Section("Ledger") { Text(ledger).font(.footnote.monospaced()).textSelection(.enabled) } }
            if let error { Section { Text(error).foregroundStyle(.red) } }
            Section { Button("Delete Goal", role: .destructive) { confirmingDelete = true } }
        }
        .navigationTitle(current.name ?? "Goal")
        .toolbar { Button("Edit") { showingEditor = true } }
        .sheet(isPresented: $showingEditor) { NavigationStack { GoalEditorView(goal: current) { body in await update(body) } } }
        .confirmationDialog("Delete this goal?", isPresented: $confirmingDelete, titleVisibility: .visible) { Button("Delete", role: .destructive) { Task { await delete() } } }
        .task { await refreshDetail() }
    }
    private func refreshDetail() async { guard let id = current.id else { return }; do { current = try await SettingsAPI.goal(id: id) } catch { self.error = error.localizedDescription } }
    private func update(_ body: [String: Any]) async -> String? { guard let id = current.id else { return "Goal ID is missing." }; do { _ = try await SettingsAPI.updateGoal(id: id, patch: body); await refreshDetail(); await onChanged(); return nil } catch { self.error = error.localizedDescription; return error.localizedDescription } }
    private func wake() async { guard let id = current.id else { return }; do { _ = try await SettingsAPI.runGoal(id: id); await refreshDetail(); await onChanged() } catch { self.error = error.localizedDescription } }
    private func pause() async { guard let id = current.id else { return }; do { _ = try await SettingsAPI.pauseGoal(id: id); await refreshDetail(); await onChanged() } catch { self.error = error.localizedDescription } }
    private func resume() async { guard let id = current.id else { return }; do { _ = try await SettingsAPI.resumeGoal(id: id); await refreshDetail(); await onChanged() } catch { self.error = error.localizedDescription } }
    private func delete() async { guard let id = current.id else { return }; do { _ = try await SettingsAPI.deleteGoal(id: id); await onChanged(); dismiss() } catch { self.error = error.localizedDescription } }
}

private struct GoalEditorView: View {
    let goal: Goal?
    let save: ([String: Any]) async -> String?
    @Environment(\.dismiss) private var dismiss
    @State private var name: String; @State private var mission: String; @State private var mode: String
    @State private var repo: String; @State private var model: String; @State private var minWakeMinutes: Int; @State private var maxWakes: Int
    @State private var mcpAccess: String; @State private var mcpServers: String; @State private var saving = false; @State private var error: String?
    init(goal: Goal? = nil, save: @escaping ([String: Any]) async -> String?) {
        self.goal = goal; self.save = save
        _name = State(initialValue: goal?.name ?? ""); _mission = State(initialValue: goal?.mission ?? ""); _mode = State(initialValue: goal?.mode ?? "ask")
        _repo = State(initialValue: goal?.repo ?? ""); _model = State(initialValue: goal?.model ?? ""); _minWakeMinutes = State(initialValue: goal?.minWakeMinutes ?? 30); _maxWakes = State(initialValue: goal?.maxWakes ?? 0); _mcpAccess = State(initialValue: goal?.mcpServers == nil ? "all" : (goal?.mcpServers?.isEmpty == true ? "none" : "selected")); _mcpServers = State(initialValue: goal?.mcpServers?.joined(separator: ", ") ?? "")
    }
    var body: some View {
        Form {
            Section("Goal") { TextField("Name", text: $name); TextEditor(text: $mission).frame(minHeight: 160).overlay(alignment: .topLeading) { if mission.isEmpty { Text("Mission").foregroundStyle(.tertiary).padding(.top, 8).allowsHitTesting(false) } } }
            Section("Execution") { Picker("Mode", selection: $mode) { Text("Ask").tag("ask"); Text("Code").tag("code") }.pickerStyle(.segmented); TextField("Repository (optional)", text: $repo); TextField("Model (optional)", text: $model).autocorrectionDisabled().noAutocapitalizationCompat(); Picker("MCP access", selection: $mcpAccess) { Text("All configured servers").tag("all"); Text("No MCP servers").tag("none"); Text("Selected servers").tag("selected") }; if mcpAccess == "selected" { TextField("MCP servers (comma separated)", text: $mcpServers).autocorrectionDisabled().noAutocapitalizationCompat() } }
            Section("Wake Schedule") { Stepper("Minimum cadence: \(minWakeMinutes) min", value: $minWakeMinutes, in: 5...1440, step: 5); Stepper("Maximum wakes: \(maxWakes == 0 ? "Unlimited" : String(maxWakes))", value: $maxWakes, in: 0...10000) }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }
        .navigationTitle(goal == nil ? "New Goal" : "Edit Goal")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button(saving ? "Saving…" : "Save") { Task { await submit() } }.disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || mission.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) } }
    }
    private func submit() async { saving = true; defer { saving = false }; let servers = mcpServers.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }; var body: [String: Any] = ["name": name, "mission": mission, "mode": mode, "repo": repo, "model": model, "minWakeMinutes": minWakeMinutes, "maxWakes": maxWakes, "createdBy": ServerConfig.shared.userName]; if mcpAccess == "none" { body["mcpServers"] = [] }; if mcpAccess == "selected" { body["mcpServers"] = servers }; if mcpAccess == "all", goal != nil { body["mcpServers"] = NSNull() }; if let message = await save(body) { error = message } else { dismiss() } }
}

struct ActionSettingsView: View {
    @State private var actions: [Action] = SettingsCache.value("actions") ?? []; @State private var loading = false; @State private var error: String?; @State private var showingEditor = false
    private var records: [Action] { actions.filter { $0.id != nil } }
    var body: some View {
        List {
            if loading && records.isEmpty { ProgressView("Loading actions…") }
            else if let error, records.isEmpty { ContentUnavailableView("Unable to Load", systemImage: "exclamationmark.triangle", description: Text(error)) }
            else if records.isEmpty { ContentUnavailableView("No Actions", systemImage: "bolt", description: Text("Create a saved script or MCP tool action.")) }
            else { ForEach(records, id: \.id) { action in
                NavigationLink { ActionDetailView(action: action, onChanged: load) } label: {
                    VStack(alignment: .leading, spacing: 4) { Text(action.name ?? "Unnamed action"); Text(action.kind == "mcp" ? "MCP: \(action.mcpServer ?? "") / \(action.toolName ?? "")" : "Repo: \(action.repo ?? "") / \(action.scriptPath ?? "")").font(.footnote).foregroundStyle(.secondary) }
                }
            } }
        }
        .navigationTitle("Actions").toolbar { Button { showingEditor = true } label: { Label("New Action", systemImage: "plus") } }
        .task { await load() }.refreshable { await load() }
        .sheet(isPresented: $showingEditor) { NavigationStack { ActionEditorView { body in await create(body) } } }
    }
    private func load() async { loading = true; defer { loading = false }; do { actions = try await SettingsAPI.actions(); error = nil; SettingsCache.save("actions", actions) } catch { self.error = error.localizedDescription } }
    private func create(_ body: [String: Any]) async -> String? { do { _ = try await SettingsAPI.createAction(body); await load(); return nil } catch { return error.localizedDescription } }
}

private struct ActionDetailView: View {
    @Environment(\.dismiss) private var dismiss
    let action: Action; let onChanged: () async -> Void
    @State private var values: [String: String] = [:]; @State private var booleanValues: [String: Bool] = [:]; @State private var result: String?; @State private var confirmingDelete = false; @State private var confirmingRun = false; @State private var running = false
    var body: some View {
        Form {
            Section("Action") { if let description = action.description { Text(description) }; LabeledContent("Kind", value: action.kind ?? "repo"); if action.kind == "mcp" { LabeledContent("Server", value: action.mcpServer ?? ""); LabeledContent("Tool", value: action.toolName ?? "") } else { LabeledContent("Repository", value: action.repo ?? ""); LabeledContent("Script", value: action.scriptPath ?? "") } }
            if let inputs = action.inputs?.filter({ $0.name != nil }), !inputs.isEmpty { Section("Inputs") { ForEach(inputs, id: \.id) { input in ActionInputControl(input: input, values: $values, booleanValues: $booleanValues) } } }
            Section { Button(running ? "Running…" : (action.confirm == true ? "Confirm & Run Action" : "Run Action")) { if action.confirm == true { confirmingRun = true } else { Task { await run() } } }.disabled(running) }
            if let result { Section("Result") { Text(result).textSelection(.enabled) } }
            Section { Button("Delete Action", role: .destructive) { confirmingDelete = true } }
        }
        .navigationTitle(action.name ?? "Action")
        .confirmationDialog("Run this action?", isPresented: $confirmingRun, titleVisibility: .visible) { Button("Run", role: .destructive) { Task { await run() } }; Button("Cancel", role: .cancel) {} } message: { Text("This action is marked as requiring confirmation and may affect production.") }
        .confirmationDialog("Delete this action?", isPresented: $confirmingDelete, titleVisibility: .visible) { Button("Delete", role: .destructive) { Task { await delete() } } }
    }
    private func run() async { guard let id = action.id else { return }; running = true; defer { running = false }; var payload: [String: Any] = values; for (name, value) in booleanValues { payload[name] = value }; do { let response = try await SettingsAPI.runAction(id: id, values: payload, user: ServerConfig.shared.userName); result = response.sessionId.map { "Started session \($0)" } ?? (response.error ?? "Action failed") } catch { result = error.localizedDescription } }
    private func delete() async { guard let id = action.id else { return }; do { _ = try await SettingsAPI.deleteAction(id: id); await onChanged(); dismiss() } catch { result = error.localizedDescription } }
}

private struct ActionInputControl: View {
    let input: ActionInput
    @Binding var values: [String: String]; @Binding var booleanValues: [String: Bool]
    private var name: String { input.name ?? "" }; private var label: String { input.label ?? name }
    var body: some View {
        if input.type == "boolean" { Toggle(label, isOn: Binding(get: { booleanValues[name] ?? (input.default == "true") }, set: { booleanValues[name] = $0 })) }
        else if input.type == "select" { Picker(label, selection: Binding(get: { values[name] ?? input.default ?? input.options?.first ?? "" }, set: { values[name] = $0 })) { ForEach(input.options ?? [], id: \.self) { Text($0).tag($0) } } }
        else { TextField(label, text: Binding(get: { values[name] ?? input.default ?? "" }, set: { values[name] = $0 }), prompt: input.hint.map { Text($0) }).keyboardTypeCompat(input.type == "number") }
    }
}

private extension View {
    @ViewBuilder func keyboardTypeCompat(_ isNumber: Bool) -> some View {
        #if os(iOS)
        if isNumber { self.keyboardType(.decimalPad) } else { self }
        #else
        self
        #endif
    }
}

private struct ActionEditorView: View {
    let save: ([String: Any]) async -> String?; @Environment(\.dismiss) private var dismiss
    @State private var name = ""; @State private var description = ""; @State private var kind = "repo"; @State private var repo = ""; @State private var scriptPath = ""; @State private var argMode = "positional"; @State private var mcpServer = ""; @State private var toolName = ""; @State private var model = ""; @State private var confirm = true; @State private var inputs: [ActionInputDraft] = []; @State private var saving = false; @State private var error: String?
    var body: some View {
        Form {
            Section("Action") { TextField("Name", text: $name); TextField("Description (optional)", text: $description); Picker("Type", selection: $kind) { Text("Repository script").tag("repo"); Text("MCP tool").tag("mcp") }.pickerStyle(.segmented) }
            if kind == "repo" { Section("Repository Script") { TextField("Repository", text: $repo); TextField("Relative script path", text: $scriptPath).autocorrectionDisabled().noAutocapitalizationCompat(); Picker("Arguments", selection: $argMode) { Text("Positional").tag("positional"); Text("Environment").tag("env") }.pickerStyle(.segmented) } }
            else { Section("MCP Tool") { TextField("MCP server", text: $mcpServer).autocorrectionDisabled().noAutocapitalizationCompat(); TextField("Tool name", text: $toolName).autocorrectionDisabled().noAutocapitalizationCompat() } }
            Section("Inputs") {
                ForEach($inputs) { $input in
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("Variable name", text: $input.name).autocorrectionDisabled().noAutocapitalizationCompat()
                        TextField("Label", text: $input.label)
                        Picker("Type", selection: $input.type) { Text("Text").tag("text"); Text("Number").tag("number"); Text("Boolean").tag("boolean") }
                        Toggle("Required", isOn: $input.required)
                    }
                }
                .onDelete { inputs.remove(atOffsets: $0) }
                Button { inputs.append(ActionInputDraft()) } label: { Label("Add input", systemImage: "plus") }
            }
            Section("Execution") { TextField("Model (optional)", text: $model).autocorrectionDisabled().noAutocapitalizationCompat(); Toggle("Require confirmation", isOn: $confirm) }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }
        .navigationTitle("New Action")
        .task {
            if repo.isEmpty {
                let repos = (try? await OS1API.repos()) ?? []
                repo = repos.first(where: { $0.isDefault == true })?.id ?? repos.first?.id ?? ""
            }
        }
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button(saving ? "Saving…" : "Save") { Task { await submit() } }.disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (kind == "repo" ? scriptPath.isEmpty : mcpServer.isEmpty || toolName.isEmpty)) } }
    }
    private func submit() async { saving = true; defer { saving = false }; let encodedInputs: [[String: Any]] = inputs.filter { !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }.map { ["name": $0.name, "label": $0.label.isEmpty ? $0.name : $0.label, "type": $0.type, "required": $0.required] }; let body: [String: Any] = ["name": name, "description": description, "kind": kind, "repo": repo, "scriptPath": scriptPath, "argMode": argMode, "mcpServer": mcpServer, "toolName": toolName, "model": model, "confirm": confirm, "createdBy": ServerConfig.shared.userName, "inputs": encodedInputs]; if let message = await save(body) { error = message } else { dismiss() } }
}

private struct ActionInputDraft: Identifiable {
    let id = UUID()
    var name = ""
    var label = ""
    var type = "text"
    var required = false
}

struct SecuritySettingsView: View {
    @State private var state: SecurityState = SettingsCache.value("security") ?? SecurityState(); @State private var loading = false; @State private var error: String?; @State private var notice: String?; @State private var showingScanEditor = false; @State private var showingProfileEditor = false
    private var scans: [SecurityScan] { (state.scans ?? []).filter { $0.id != nil } }; private var profiles: [SecurityProfile] { (state.profiles ?? []).filter { $0.id != nil } }
    var body: some View {
        List {
            if let notice { Section { Text(notice).foregroundStyle(.secondary) } }
            Section("Scans") {
                if loading && scans.isEmpty { ProgressView("Loading security scans…") }
                else if scans.isEmpty { Text(error ?? "No security scans yet.").foregroundStyle(error == nil ? Color.secondary : Color.red) }
                else { ForEach(scans, id: \.id) { scan in NavigationLink { SecurityScanDetailView(scan: scan, onChanged: load) } label: { VStack(alignment: .leading, spacing: 4) { Text(scan.profileName ?? "Custom scan"); Text(scan.repos?.joined(separator: ", ") ?? "No repositories").font(.footnote).foregroundStyle(.secondary); StatusBadge(text: scan.status ?? "queued") } } } }
                Button { showingScanEditor = true } label: { Label("New Scan", systemImage: "plus") }
            }
            Section("Profiles") {
                if profiles.isEmpty { Text("No profiles").foregroundStyle(.secondary) }
                ForEach(profiles, id: \.id) { profile in NavigationLink { SecurityProfileEditorView(profile: profile, onDeleted: load) { body in await updateProfile(profile, body) } } label: { VStack(alignment: .leading, spacing: 3) { Text(profile.name ?? "Unnamed profile"); Text(profile.prompt ?? "").lineLimit(2).font(.footnote).foregroundStyle(.secondary) } } }
                Button { showingProfileEditor = true } label: { Label("New Profile", systemImage: "plus") }
            }
        }
        .navigationTitle("Security")
        .task { await load() }.refreshable { await load() }
        .sheet(isPresented: $showingScanEditor) { NavigationStack { SecurityScanEditorView(state: state) { body in try await createScan(body) } } }
        .sheet(isPresented: $showingProfileEditor) { NavigationStack { SecurityProfileEditorView { body in await createProfile(body) } } }
    }
    private func load() async { loading = true; defer { loading = false }; do { state = try await SettingsAPI.security(); error = nil; SettingsCache.save("security", state) } catch { self.error = error.localizedDescription } }
    private func createScan(_ body: [String: Any]) async throws -> SecurityScanResult { let result = try await SettingsAPI.createSecurityScan(body); if let sessionId = result.sessionId { notice = "Started interactive session \(sessionId)." } else if let automation = result.automation { notice = "Created recurring automation \(automation.name ?? automation.id ?? "")." } else { notice = "Security scan started." }; await load(); return result }
    private func createProfile(_ body: [String: Any]) async -> String? { do { _ = try await SettingsAPI.createSecurityProfile(body); await load(); return nil } catch { return error.localizedDescription } }
    private func updateProfile(_ profile: SecurityProfile, _ body: [String: Any]) async -> String? { guard let id = profile.id else { return "Security profile ID is missing." }; do { _ = try await SettingsAPI.updateSecurityProfile(id: id, patch: body); await load(); return nil } catch { return error.localizedDescription } }
}

private struct SecurityScanDetailView: View {
    @Environment(\.dismiss) private var dismiss
    let scan: SecurityScan; let onChanged: () async -> Void; @State private var confirmingDelete = false; @State private var error: String?
    var body: some View {
        Form {
            Section("Scan") { LabeledContent("Status", value: scan.status ?? "queued"); LabeledContent("Repositories", value: scan.repos?.joined(separator: ", ") ?? "None"); if let profile = scan.profileName { LabeledContent("Profile", value: profile) }; if let created = scan.createdAt { LabeledContent("Created", value: created) }; if let finished = scan.finishedAt { LabeledContent("Finished", value: finished) } }
            if let instructions = scan.instructions, !instructions.isEmpty { Section("Instructions") { Text(instructions).textSelection(.enabled) } }
            if let sessions = scan.sessions?.filter({ $0.id != nil }), !sessions.isEmpty { Section("Sessions") { ForEach(sessions, id: \.id) { session in VStack(alignment: .leading) { Text(session.repo ?? "Repository"); Text(session.status ?? "unknown").font(.caption).foregroundStyle(.secondary); if let error = session.error { Text(error).font(.caption).foregroundStyle(.red) } } } } }
            if let error { Section { Text(error).foregroundStyle(.red) } }
            Section { Button("Delete Scan Record", role: .destructive) { confirmingDelete = true } }
        }
        .navigationTitle(scan.profileName ?? "Security Scan")
        .confirmationDialog("Delete this scan record?", isPresented: $confirmingDelete, titleVisibility: .visible) { Button("Delete", role: .destructive) { Task { await delete() } } }
    }
    private func delete() async { guard let id = scan.id else { return }; do { _ = try await SettingsAPI.deleteSecurityScan(id: id); await onChanged(); dismiss() } catch { self.error = error.localizedDescription } }
}

private struct SecurityScanEditorView: View {
    let state: SecurityState; let save: ([String: Any]) async throws -> SecurityScanResult; @Environment(\.dismiss) private var dismiss
    @State private var selectedRepos: Set<String> = []; @State private var profileId = ""; @State private var instructions = ""; @State private var recurrence = "once"; @State private var interactive = false; @State private var saving = false; @State private var error: String?
    private var repos: [SecurityRepo] { (state.repos ?? []).filter { $0.id != nil } }; private var profiles: [SecurityProfile] { (state.profiles ?? []).filter { $0.id != nil } }
    private var primaryRepo: String? { repos.first?.id }
    var body: some View {
        Form {
            Section("Repositories") {
                if repos.isEmpty {
                    Text("No scannable repositories").foregroundStyle(.secondary)
                }
                ForEach(repos, id: \.id) { repo in
                    if let id = repo.id {
                        Toggle(id, isOn: repoSelection(id))
                            .disabled((recurrence != "once" || interactive) && id != primaryRepo)
                    }
                }
            }
            Section("Profile") { Picker("Profile", selection: $profileId) { Text("Custom instructions").tag(""); ForEach(profiles, id: \.id) { profile in if let id = profile.id { Text(profile.name ?? id).tag(id) } } } }
            Section("Instructions") { TextEditor(text: $instructions).frame(minHeight: 120) }
            Section("Run") { Picker("Recurrence", selection: $recurrence) { Text("Run once").tag("once"); Text("Daily").tag("daily"); Text("Weekly").tag("weekly") }; Toggle("Interactive planning session", isOn: $interactive).disabled(recurrence != "once") }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }
        .navigationTitle("New Security Scan")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button(saving ? "Starting…" : "Start") { Task { await submit() } }.disabled(saving || selectedRepos.isEmpty) } }
        .onChange(of: recurrence) { _, value in if value != "once" { interactive = false; selectedRepos = Set(primaryRepo.map { [$0] } ?? []) } }
        .onChange(of: interactive) { _, value in if value { recurrence = "once"; selectedRepos = Set(primaryRepo.map { [$0] } ?? []) } }
    }
    private func repoSelection(_ id: String) -> Binding<Bool> {
        Binding(
            get: { selectedRepos.contains(id) },
            set: { selected in
                if selected { selectedRepos.insert(id) }
                else { selectedRepos.remove(id) }
            }
        )
    }
    private func submit() async { saving = true; defer { saving = false }; var body: [String: Any] = ["repos": Array(selectedRepos), "profileId": profileId, "instructions": instructions, "interactive": interactive, "createdBy": ServerConfig.shared.userName]; if recurrence != "once" { body["recurrence"] = recurrence }; do { _ = try await save(body); dismiss() } catch { self.error = error.localizedDescription } }
}

private struct SecurityProfileEditorView: View {
    let profile: SecurityProfile?; let onDeleted: () async -> Void; let save: ([String: Any]) async -> String?; @Environment(\.dismiss) private var dismiss
    @State private var name: String; @State private var prompt: String; @State private var saving = false; @State private var error: String?; @State private var confirmingDelete = false
    init(profile: SecurityProfile? = nil, onDeleted: @escaping () async -> Void = {}, save: @escaping ([String: Any]) async -> String?) { self.profile = profile; self.onDeleted = onDeleted; self.save = save; _name = State(initialValue: profile?.name ?? ""); _prompt = State(initialValue: profile?.prompt ?? "") }
    var body: some View {
        Form { Section("Profile") { TextField("Name", text: $name); TextEditor(text: $prompt).frame(minHeight: 180) }; if let error { Section { Text(error).foregroundStyle(.red) } }; if profile != nil { Section { Button("Delete Profile", role: .destructive) { confirmingDelete = true } } } }
        .navigationTitle(profile == nil ? "New Profile" : "Edit Profile")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button(saving ? "Saving…" : "Save") { Task { await submit() } }.disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) } }
        .confirmationDialog("Delete this security profile?", isPresented: $confirmingDelete, titleVisibility: .visible) { Button("Delete", role: .destructive) { Task { await delete() } } }
    }
    private func submit() async { saving = true; defer { saving = false }; let body: [String: Any] = ["name": name, "prompt": prompt, "createdBy": ServerConfig.shared.userName]; if let message = await save(body) { error = message } else { dismiss() } }
    private func delete() async { guard let id = profile?.id else { return }; do { _ = try await SettingsAPI.deleteSecurityProfile(id: id); await onDeleted(); dismiss() } catch { self.error = error.localizedDescription } }
}

private struct StatusBadge: View {
    let text: String
    var body: some View { Text(text).font(.caption.weight(.medium)).foregroundStyle(.secondary).padding(.horizontal, 7).padding(.vertical, 3).background(.fill.tertiary, in: Capsule()) }
}
