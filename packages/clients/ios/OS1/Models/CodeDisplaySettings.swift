import SwiftUI

/// Native rendering preferences shared by worktree Changes and pull request
/// review. They are device-local: code presentation is a reader preference,
/// not session data.
struct CodeDisplaySettings: Equatable {
    enum Theme: String, CaseIterable, Identifiable {
        case system, light, dark

        var id: String { rawValue }

        var label: String {
            switch self {
            case .system: "Match app"
            case .light: "Light"
            case .dark: "Dark"
            }
        }
    }

    var style: PrDiffStyle
    var wrapLines: Bool
    var highlightEdits: Bool
    var showFileStats: Bool
    var theme: Theme

    static let defaults = CodeDisplaySettings(
        style: .unified,
        wrapLines: false,
        highlightEdits: true,
        showFileStats: true,
        theme: .system
    )

    // Keep the two pre-existing PR keys so an upgrade preserves choices. Both
    // surfaces now read them; the names are persistence ABI, not ownership.
    static let styleKey = "os1.pr.diffStyle"
    static let wrapKey = "os1.pr.wrapLines"
    static let highlightKey = "os1.code.highlightEdits"
    static let statsKey = "os1.code.showFileStats"
    static let themeKey = "os1.code.theme"

    static func load(from store: UserDefaults) -> CodeDisplaySettings {
        let fallback = defaults
        return CodeDisplaySettings(
            style: store.string(forKey: styleKey).flatMap(PrDiffStyle.init(rawValue:))
                ?? fallback.style,
            wrapLines: store.object(forKey: wrapKey) as? Bool ?? fallback.wrapLines,
            highlightEdits: store.object(forKey: highlightKey) as? Bool
                ?? fallback.highlightEdits,
            showFileStats: store.object(forKey: statsKey) as? Bool
                ?? fallback.showFileStats,
            theme: store.string(forKey: themeKey).flatMap(Theme.init(rawValue:))
                ?? fallback.theme
        )
    }

    func save(to store: UserDefaults) {
        store.set(style.rawValue, forKey: Self.styleKey)
        store.set(wrapLines, forKey: Self.wrapKey)
        store.set(highlightEdits, forKey: Self.highlightKey)
        store.set(showFileStats, forKey: Self.statsKey)
        store.set(theme.rawValue, forKey: Self.themeKey)
    }
}

/// One native settings section reused by both code surfaces.
///
/// The web's "structural highlighting" is intraline syntax-tree highlighting.
/// Native patches currently carry line-level data only, so that exact choice
/// is deliberately unsupported. "Highlight edits" honestly controls the
/// addition/deletion line washes the native renderer can provide.
struct CodeDisplaySettingsControls: View {
    @Binding var styleRaw: String
    @Binding var wrapLines: Bool
    @Binding var highlightEdits: Bool
    @Binding var showFileStats: Bool
    @Binding var themeRaw: String

    var body: some View {
        Section {
            Picker("Layout", selection: style) {
                ForEach(PrDiffStyle.allCases, id: \.self) { option in
                    Label(option.label, systemImage: option.symbol).tag(option)
                }
            }
            .pickerStyle(.inline)
            Toggle("Wrap lines", isOn: $wrapLines)
            Toggle("Highlight edits", isOn: $highlightEdits)
            Toggle("File statistics", isOn: $showFileStats)
            Picker("Theme", selection: theme) {
                ForEach(CodeDisplaySettings.Theme.allCases) { option in
                    Text(option.label).tag(option)
                }
            }
            .pickerStyle(.inline)
        }
    }

    private var style: Binding<PrDiffStyle> {
        Binding(
            get: { PrDiffStyle(rawValue: styleRaw) ?? CodeDisplaySettings.defaults.style },
            set: { styleRaw = $0.rawValue }
        )
    }

    private var theme: Binding<CodeDisplaySettings.Theme> {
        Binding(
            get: {
                CodeDisplaySettings.Theme(rawValue: themeRaw)
                    ?? CodeDisplaySettings.defaults.theme
            },
            set: { themeRaw = $0.rawValue }
        )
    }
}

/// Standalone native settings popover used by both code toolbars.
struct CodeDisplaySettingsButton: View {
    @AppStorage(CodeDisplaySettings.styleKey) private var styleRaw = "unified"
    @AppStorage(CodeDisplaySettings.wrapKey) private var wrapLines = false
    @AppStorage(CodeDisplaySettings.highlightKey) private var highlightEdits = true
    @AppStorage(CodeDisplaySettings.statsKey) private var showFileStats = true
    @AppStorage(CodeDisplaySettings.themeKey) private var themeRaw = "system"
    @State private var presented = false

    var body: some View {
        Button { presented = true } label: {
            Label("Code display", systemImage: "slider.horizontal.3")
        }
        .popover(isPresented: $presented) {
            NavigationStack {
                Form {
                    CodeDisplaySettingsControls(
                        styleRaw: $styleRaw,
                        wrapLines: $wrapLines,
                        highlightEdits: $highlightEdits,
                        showFileStats: $showFileStats,
                        themeRaw: $themeRaw
                    )
                }
                .navigationTitle("Code display")
                .inlineTitleBarCompat()
            }
            .frame(minWidth: 320, minHeight: 420)
            .presentationCompactAdaptation(.popover)
        }
        .task {
            #if DEBUG
            let environment = ProcessInfo.processInfo.environment
            if environment["OS1_CODE_DISPLAY_PRESET"] == "dark-split-no-stats" {
                styleRaw = PrDiffStyle.split.rawValue
                wrapLines = true
                highlightEdits = true
                showFileStats = false
                themeRaw = CodeDisplaySettings.Theme.dark.rawValue
            }
            if environment["OS1_OPEN_CODE_SETTINGS"] == "1" {
                // Let UIKit attach the toolbar button before asking its popover
                // controller for an anchor. Presenting during the first body
                // pass aborts because the source view is not in a window yet.
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else { return }
                presented = true
            }
            #endif
        }
    }
}

struct CodeDisplayTheme: ViewModifier {
    @AppStorage(CodeDisplaySettings.themeKey) private var themeRaw = "system"
    @Environment(\.colorScheme) private var appColorScheme

    func body(content: Content) -> some View {
        content.environment(\.colorScheme, resolvedColorScheme)
    }

    private var resolvedColorScheme: ColorScheme {
        switch CodeDisplaySettings.Theme(rawValue: themeRaw) ?? .system {
        case .system: appColorScheme
        case .light: .light
        case .dark: .dark
        }
    }
}

extension View {
    func codeDisplayTheme() -> some View {
        modifier(CodeDisplayTheme())
    }
}
