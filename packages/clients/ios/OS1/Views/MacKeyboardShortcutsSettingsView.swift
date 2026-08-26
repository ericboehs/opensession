#if os(macOS)
import AppKit
import SwiftUI

/// The account keyboard bindings this Mac app can execute. The iOS Shortcuts
/// pane remains the system App Shortcut and widget guide.
struct MacKeyboardShortcutsSettingsView: View {
    @AppStorage(AccountShortcuts.storageKey) private var rawShortcuts = AccountShortcuts.emptyRawValue
    @State private var recording: AccountShortcutCommand?
    @State private var problem: String?
    @State private var saveProblem: String?
    @State private var saving = false

    private var shortcuts: AccountShortcuts { AccountShortcuts(rawValue: rawShortcuts) }

    var body: some View {
        Form {
            Section {
                ForEach(AccountShortcutCommand.allCases) { command in
                    LabeledContent {
                        HStack(spacing: 8) {
                            Button(bindingLabel(for: command)) {
                                problem = nil
                                recording = command
                            }
                            .monospacedDigit()
                            .disabled(saving)

                            if shortcuts.isCustomized(command) {
                                Button("Reset") { update { $0.reset(command) } }
                                    .buttonStyle(.plain)
                                    .foregroundStyle(.secondary)
                                    .disabled(saving)
                            }
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(command.title)
                            Text(command.detail)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                Text("Commands")
            } footer: {
                Text("Custom bindings follow your account. This Mac uses the first compatible binding for each command it supports.")
            }

            if AccountShortcutCommand.allCases.contains(where: shortcuts.isCustomized) {
                Section {
                    Button("Reset all", role: .destructive) {
                        update { $0.resetSupportedCommands() }
                    }
                    .disabled(saving)
                }
            }

            if saving {
                Section {
                    ProgressView("Saving…")
                }
            }

            if let saveProblem {
                Section {
                    Text(saveProblem)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Keyboard shortcuts")
        .task { await NativePreferences.hydrate() }
        .sheet(item: $recording) { command in
            recorder(for: command)
        }
    }

    private func bindingLabel(for command: AccountShortcutCommand) -> String {
        shortcuts.primaryBinding(for: command)?.label ?? "Unassigned"
    }

    private func update(_ change: (inout AccountShortcuts) -> Void) {
        guard !saving else { return }
        var next = shortcuts
        change(&next)
        saveProblem = nil
        saving = true
        let requestContext = NativePreferences.context()
        Task {
            defer { saving = false }
            do {
                let response = try await SettingsAPI.updateUiPrefs(
                    user: requestContext.user,
                    prefs: ["shortcuts": next.rawValue]
                )
                guard response["shortcuts"] == next.rawValue else {
                    saveProblem = "The server did not accept this shortcut."
                    return
                }
                guard NativePreferences.apply(response, for: requestContext) else {
                    saveProblem = "The connection changed before the shortcut finished saving."
                    return
                }
            } catch {
                saveProblem = error.localizedDescription
            }
        }
    }

    private func accept(_ chord: AccountShortcutChord, for command: AccountShortcutCommand) {
        guard chord.isUsable(on: command) else {
            problem = chord.isBindable
                ? "macOS already uses \(chord.label)."
                : "Hold ⌘, ⌃, or ⌥ as part of the shortcut."
            return
        }
        if let conflict = AccountShortcutCommand.allCases.first(where: {
            $0 != command && shortcuts.primaryBinding(for: $0) == chord
        }) {
            problem = "\(chord.label) is already used by \(conflict.title)."
            return
        }
        update { $0.setPrimaryBinding(chord, for: command) }
        recording = nil
    }

    @ViewBuilder
    private func recorder(for command: AccountShortcutCommand) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "keyboard")
                .font(.system(size: 28))
                .foregroundStyle(OS1VisualStyle.accentInk)
            VStack(spacing: 5) {
                Text(command.title)
                    .font(.headline)
                Text("Press the shortcut you want to use.")
                    .foregroundStyle(.secondary)
            }
            ShortcutCaptureView(
                onCapture: { chord in accept(chord, for: command) },
                onCancel: { recording = nil }
            )
            .frame(width: 1, height: 1)
            if let problem {
                Text(problem)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
            HStack {
                Button("Cancel", role: .cancel) { recording = nil }
                Spacer()
                if shortcuts.isCustomized(command) {
                    Button("Reset to default") {
                        update { $0.reset(command) }
                        recording = nil
                    }
                }
                Button("Remove shortcut", role: .destructive) {
                    update { $0.removeBindings(for: command) }
                    recording = nil
                }
            }
        }
        .padding(24)
        .frame(width: 420)
    }
}

private struct ShortcutCaptureView: NSViewRepresentable {
    var onCapture: (AccountShortcutChord) -> Void
    var onCancel: () -> Void

    func makeNSView(context: Context) -> CaptureView {
        let view = CaptureView()
        view.onCapture = onCapture
        view.onCancel = onCancel
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return view
    }

    func updateNSView(_ view: CaptureView, context: Context) {
        view.onCapture = onCapture
        view.onCancel = onCancel
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
    }

    final class CaptureView: NSView {
        var onCapture: ((AccountShortcutChord) -> Void)?
        var onCancel: (() -> Void)?

        override var acceptsFirstResponder: Bool { true }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            DispatchQueue.main.async { self.window?.makeFirstResponder(self) }
        }

        override func performKeyEquivalent(with event: NSEvent) -> Bool {
            capture(event)
            return true
        }

        override func keyDown(with event: NSEvent) {
            capture(event)
        }

        private func capture(_ event: NSEvent) {
            if event.keyCode == 53 {
                onCancel?()
                return
            }
            guard let key = Self.keyToken(for: event) else { return }
            var modifiers: AccountShortcutModifiers = []
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if flags.contains(.command) { modifiers.insert(.command) }
            if flags.contains(.control) { modifiers.insert(.control) }
            if flags.contains(.option) { modifiers.insert(.option) }
            if flags.contains(.shift) { modifiers.insert(.shift) }
            guard let chord = AccountShortcutChord(key: key, modifiers: modifiers), chord.isBindable else {
                NSSound.beep()
                return
            }
            onCapture?(chord)
        }

        private static func keyToken(for event: NSEvent) -> String? {
            let special: [UInt16: String] = [
                36: "enter", 48: "tab", 49: "space", 51: "backspace", 53: "escape",
                115: "home", 116: "pageup", 117: "delete", 119: "end", 121: "pagedown",
                123: "arrowleft", 124: "arrowright", 125: "arrowdown", 126: "arrowup",
                122: "f1", 120: "f2", 99: "f3", 118: "f4", 96: "f5", 97: "f6",
                98: "f7", 100: "f8", 101: "f9", 109: "f10", 103: "f11", 111: "f12",
                105: "f13", 107: "f14", 113: "f15", 106: "f16", 64: "f17", 79: "f18",
                80: "f19", 90: "f20",
            ]
            if let token = special[event.keyCode] { return token }
            guard let characters = event.charactersIgnoringModifiers?.lowercased(),
                  characters.count == 1
            else { return nil }
            let ascii = characters.unicodeScalars.first.map { $0.value < 0x80 } == true
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if (flags.contains(.option) || !ascii), let letter = ansiLetters[event.keyCode] {
                return letter
            }
            if (flags.contains(.option) || flags.contains(.shift) || !ascii),
               let digit = ansiDigits[event.keyCode] {
                return digit
            }
            return characters
        }

        private static let ansiLetters: [UInt16: String] = [
            0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x",
            8: "c", 9: "v", 11: "b", 12: "q", 13: "w", 14: "e", 15: "r",
            16: "y", 17: "t", 31: "o", 32: "u", 34: "i", 35: "p", 37: "l",
            38: "j", 40: "k", 45: "n", 46: "m",
        ]

        private static let ansiDigits: [UInt16: String] = [
            18: "1", 19: "2", 20: "3", 21: "4", 23: "5",
            22: "6", 26: "7", 28: "8", 25: "9", 29: "0",
        ]
    }
}
#endif
