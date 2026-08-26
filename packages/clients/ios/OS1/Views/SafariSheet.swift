#if os(iOS)
import SafariServices
import SwiftUI

/// A web link from a transcript, opened over the session rather than
/// instead of it.
///
/// Handing the URL to the system swaps to Safari as a separate app: the
/// session you were reading is gone, coming back means a cold relaunch of the
/// list, and the PR you tapped is now a tab you have to close later. A
/// `SFSafariViewController` on top keeps the conversation one swipe away,
/// which is what following a link mid-thread is actually for.
struct SafariLink: Identifiable, Equatable {
    let url: URL
    var id: String { url.absoluteString }

    /// `SFSafariViewController` only accepts web URLs — anything else (a
    /// `mailto:`, a custom scheme) still belongs to the system.
    static func isWeb(_ url: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "http", "https": return true
        default: return false
        }
    }
}

struct SafariSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let config = SFSafariViewController.Configuration()
        config.barCollapsingEnabled = true
        let controller = SFSafariViewController(url: url, configuration: config)
        controller.preferredControlTintColor = UIColor(OS1VisualStyle.accentInk)
        controller.dismissButtonStyle = .done
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
#endif
