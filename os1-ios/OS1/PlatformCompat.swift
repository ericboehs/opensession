import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

// Cross-platform shims so the views share one code path between iOS and macOS.

extension ToolbarItemPlacement {
    /// `.topBarTrailing` / `.topBarLeading` don't exist on macOS; map them to
    /// the equivalent slots in a Mac toolbar.
    static var topTrailingCompat: ToolbarItemPlacement {
        #if os(iOS)
        .topBarTrailing
        #else
        .primaryAction
        #endif
    }

    static var topLeadingCompat: ToolbarItemPlacement {
        #if os(iOS)
        .topBarLeading
        #else
        .navigation
        #endif
    }
}

extension View {
    /// Inline nav-bar title on iOS; titles are inline by nature on macOS.
    @ViewBuilder
    func inlineTitleBarCompat() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    /// URL-entry field traits — software-keyboard concepts that only exist on iOS.
    @ViewBuilder
    func urlFieldCompat() -> some View {
        #if os(iOS)
        keyboardType(.URL)
            .textContentType(.URL)
            .textInputAutocapitalization(.never)
        #else
        self
        #endif
    }

    @ViewBuilder
    func noAutocapitalizationCompat() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never)
        #else
        self
        #endif
    }

    /// Interactive keyboard dismissal only exists on iOS.
    @ViewBuilder
    func scrollDismissesKeyboardCompat() -> some View {
        #if os(iOS)
        scrollDismissesKeyboard(.interactively)
        #else
        self
        #endif
    }

    /// `.insetGrouped` is iOS-only; `.inset` is the closest Mac list style.
    @ViewBuilder
    func insetGroupedListCompat() -> some View {
        #if os(iOS)
        listStyle(.insetGrouped)
        #else
        listStyle(.inset)
        #endif
    }
}

/// Cross-platform "copy to clipboard".
func copyToPasteboard(_ string: String) {
    #if canImport(UIKit)
    UIPasteboard.general.string = string
    #else
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(string, forType: .string)
    #endif
}
