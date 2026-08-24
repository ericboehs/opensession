import SwiftUI
#if os(iOS)

/// Your list.
///
/// The same list the web's Tasks page shows and the same one any session can
/// write to, which is the point of it: "put that on my list" said mid-turn
/// arrives here. So the screen is deliberately small. A field to add one, the
/// open ones, and completed folded away underneath.
///
/// Tapping the circle is the whole interaction. There is no detail screen: a
/// task is a sentence, and everything a phone could put on a second screen
/// (the note, the due date, where it came from) already fits under it.
struct TasksView: View {
    /// Opens the session that added a task. Handed up rather than pushed here,
    /// because this screen sits on the sessions list's own navigation stack.
    let onOpenSession: (String) -> Void

    @State private var tasks: [TodoItem] = []
    /// Parsed once when a response lands. Timestamp parsing in a SwiftUI body
    /// previously spent a whole scene-update watchdog allowance in ICU.
    @State private var reminderDates: [String: Date] = [:]
    @State private var draft = ""
    @State private var loading = true
    @State private var loadFailed = false
    @State private var showDone = false
    @State private var adding = false
    @State private var actionError: String?
    @FocusState private var draftFocused: Bool

    private var open: [TodoItem] { tasks.filter { $0.status == .open } }
    private var done: [TodoItem] { tasks.filter { $0.status == .done } }

    var body: some View {
        Group {
            if loading && tasks.isEmpty {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if loadFailed && tasks.isEmpty {
                failedPlaceholder
            } else {
                list
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OS1VisualStyle.background)
        .navigationTitle("Tasks")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private var list: some View {
        List {
            Section {
                addRow
            }

            if open.isEmpty {
                Section {
                    Text("Nothing on your list. Add one, or ask an agent to.")
                        .font(.footnote)
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .padding(.vertical, 6)
                }
            } else {
                Section {
                    ForEach(open) { task in
                        TaskRow(
                            task: task,
                            reminderDate: reminderDates[task.id],
                            onToggle: toggle,
                            onOpenSession: onOpenSession
                        )
                        .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    Task { await move(task, to: .dropped) }
                                } label: {
                                    Label("Drop", systemImage: "trash")
                                }
                            }
                    }
                } header: {
                    Text(open.count == 1 ? "1 open" : "\(open.count) open")
                }
            }

            if !done.isEmpty {
                Section {
                    // Folded by default. Completed work is a record, not a
                    // list you act on, and it is the longer half within a week.
                    DisclosureGroup(isExpanded: $showDone) {
                        ForEach(done) { task in
                            TaskRow(
                                task: task,
                                reminderDate: reminderDates[task.id],
                                onToggle: toggle,
                                onOpenSession: onOpenSession
                            )
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text("Completed")
                                .font(.callout.weight(.medium))
                                .foregroundStyle(OS1VisualStyle.textDim)
                            Text(verbatim: "\(done.count)")
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(OS1VisualStyle.textFaint)
                        }
                    }
                }
            }

            if let actionError {
                Section {
                    Text(actionError)
                        .font(.footnote)
                        .foregroundStyle(OS1VisualStyle.redInk)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(OS1VisualStyle.background)
        .refreshable { await load() }
    }

    private var addRow: some View {
        HStack(spacing: 10) {
            TextField("Add a task", text: $draft, axis: .vertical)
                .font(.callout)
                .foregroundStyle(OS1VisualStyle.text)
                .lineLimit(1...4)
                .focused($draftFocused)
                .submitLabel(.done)
                // A hardware Return adds it; the soft keyboard's return key
                // stays a newline, so a task can carry a second line on a
                // phone. Same rule the composer follows.
                .onSubmit { Task { await add() } }
            Button {
                Task { await add() }
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
                    .foregroundStyle(
                        canAdd ? OS1VisualStyle.accentInk : OS1VisualStyle.textFaint
                    )
            }
            .buttonStyle(.plain)
            .disabled(!canAdd)
            .accessibilityLabel("Add task")
        }
        .padding(.vertical, 2)
    }

    private var canAdd: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !adding
    }

    private var failedPlaceholder: some View {
        ListPlaceholder(
            symbol: "exclamationmark.triangle",
            title: "Couldn't load tasks",
            message: "The server didn't answer for your list."
        ) {
            Button("Try again") { Task { await load() } }
                .buttonStyle(PlaceholderActionStyle())
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let next = try await OS1API.todos()
            guard !Task.isCancelled else { return }
            tasks = next
            reminderDates = next.reduce(into: [:]) { dates, task in
                if let date = Session.parseISO(task.remindAt) { dates[task.id] = date }
            }
            loadFailed = false
            actionError = nil
        } catch {
            if tasks.isEmpty { loadFailed = true }
        }
    }

    private func add() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !adding else { return }
        adding = true
        defer { adding = false }
        do {
            let created = try await OS1API.addTodo(text: text)
            draft = ""
            actionError = nil
            tasks.insert(created, at: 0)
            await load()
        } catch {
            actionError = "The task could not be added."
        }
    }

    private func toggle(_ task: TodoItem) {
        Task { await move(task, to: task.status == .done ? .open : .done) }
    }

    /// Applied here first so the circle fills under the thumb, then confirmed
    /// by the server. A failed write says so and puts the row back, because a
    /// task that silently un-ticks itself on the next refresh is worse than an
    /// error.
    private func move(_ task: TodoItem, to status: TodoStatus) async {
        let previous = tasks
        if status == .dropped {
            tasks.removeAll { $0.id == task.id }
        } else if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = task.with(status: status)
        }
        Haptics.play(status == .done ? .commit : .selection)
        do {
            _ = try await OS1API.setTodoStatus(id: task.id, status: status)
            actionError = nil
        } catch {
            tasks = previous
            actionError = "The task could not be updated."
        }
    }
}

private extension TodoItem {
    /// The same item with one field moved. `TodoItem` is a `let`-only wire
    /// shape, so an optimistic edit rebuilds it rather than mutating it.
    func with(status: TodoStatus) -> TodoItem {
        TodoItem(
            id: id,
            user: user,
            text: text,
            status: status,
            createdAt: createdAt,
            updatedAt: updatedAt,
            completedAt: completedAt,
            note: note,
            due: due,
            remindAt: remindAt,
            remindedAt: remindedAt,
            source: source
        )
    }
}

/// One task: a circle, the sentence, and whatever context it carries.
private struct TaskRow: View {
    let task: TodoItem
    let reminderDate: Date?
    let onToggle: (TodoItem) -> Void
    let onOpenSession: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Button {
                onToggle(task)
            } label: {
                Image(systemName: task.isDone ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(
                        task.isDone ? OS1VisualStyle.accentControl : OS1VisualStyle.textFaint
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                task.isDone ? "Reopen \(task.text)" : "Mark \(task.text) done"
            )

            VStack(alignment: .leading, spacing: 3) {
                Text(task.text)
                    .font(.callout)
                    .foregroundStyle(
                        task.isDone ? OS1VisualStyle.textDim : OS1VisualStyle.text
                    )
                    .strikethrough(task.isDone, color: OS1VisualStyle.textFaint)
                if let note = task.note, !note.isEmpty {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textFaint)
                        .lineLimit(2)
                }
                if !metaLine.isEmpty {
                    Text(verbatim: metaLine)
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textFaint)
                }
                if let sessionId = task.source.sessionId {
                    Button("Open the session that added this") {
                        onOpenSession(sessionId)
                    }
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.accentInk)
                    .buttonStyle(.plain)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
    }

    /// Due date and reminder on one line, said once. Built with interpolation
    /// of already-formatted parts rather than a `LocalizedStringKey`, so no
    /// number in it is read as a quantity to localize.
    private var metaLine: String {
        var parts: [String] = []
        if let due = task.due, !due.isEmpty { parts.append("Due \(due)") }
        if !task.isDone, let reminderDate {
            let when = reminderDate.formatted(.relative(presentation: .named))
            parts.append(task.remindedAt == nil ? "Reminder \(when)" : "Reminded \(when)")
        }
        return parts.joined(separator: " · ")
    }
}
#endif
