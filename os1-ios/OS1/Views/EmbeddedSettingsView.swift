import SwiftUI
import WebKit
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

struct EmbeddedSettingsView: View {
    let onAuthenticationFailure: () -> Void
    let onOpenSession: (String) -> Void

    @State private var loading = true
    @State private var error: String?
    @State private var reloadID = UUID()

    var body: some View {
        ZStack {
            SettingsWebView(
                loading: $loading,
                error: $error,
                onAuthenticationFailure: onAuthenticationFailure,
                onOpenSession: onOpenSession
            )
            .id(reloadID)

            if loading {
                ProgressView("Loading Settings…")
            }

            if let error {
                ContentUnavailableView {
                    Label("Settings unavailable", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Retry") {
                        self.error = nil
                        loading = true
                        reloadID = UUID()
                    }
                }
                .background(OS1VisualStyle.background)
            }
        }
        .background(OS1VisualStyle.background)
    }
}

private final class SettingsWebCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    private let baseURL: URL
    private let token: String
    private let setLoading: (Bool) -> Void
    private let setError: (String?) -> Void
    private let onAuthenticationFailure: () -> Void
    private let onOpenSession: (String) -> Void

    init(
        baseURL: URL,
        token: String,
        setLoading: @escaping (Bool) -> Void,
        setError: @escaping (String?) -> Void,
        onAuthenticationFailure: @escaping () -> Void,
        onOpenSession: @escaping (String) -> Void
    ) {
        self.baseURL = baseURL
        self.token = token
        self.setLoading = setLoading
        self.setError = setError
        self.onAuthenticationFailure = onAuthenticationFailure
        self.onOpenSession = onOpenSession
    }

    func load(_ webView: WKWebView) {
        guard let url = URL(string: baseURL.absoluteString + "/api/auth/native-settings") else {
            setError("Invalid server URL.")
            return
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        webView.load(request)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        setLoading(false)
        setError(nil)
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        setLoading(false)
        setError(error.localizedDescription)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        setLoading(false)
        setError(error.localizedDescription)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if let response = navigationResponse.response as? HTTPURLResponse,
           response.statusCode == 401 {
            setLoading(false)
            onAuthenticationFailure()
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.scheme == "os1-settings" {
            if url.host == "auth-expired" {
                onAuthenticationFailure()
            } else if url.host == "session" {
                let id = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    .removingPercentEncoding ?? ""
                if !id.isEmpty { onOpenSession(id) }
            }
            decisionHandler(.cancel)
            return
        }
        let sameOrigin = url.scheme == baseURL.scheme
            && url.host == baseURL.host
            && url.port == baseURL.port
        if !sameOrigin || navigationAction.targetFrame == nil {
            openExternalURL(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url { openExternalURL(url) }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        #if canImport(UIKit)
        guard var controller = webView.window?.rootViewController else {
            completionHandler(false)
            return
        }
        while let presented = controller.presentedViewController { controller = presented }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .destructive) { _ in completionHandler(true) })
        controller.present(alert, animated: true)
        #else
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        if let window = webView.window {
            alert.beginSheetModal(for: window) { response in
                completionHandler(response == .alertFirstButtonReturn)
            }
        } else {
            completionHandler(alert.runModal() == .alertFirstButtonReturn)
        }
        #endif
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        #if canImport(UIKit)
        guard var controller = webView.window?.rootViewController else {
            completionHandler()
            return
        }
        while let presented = controller.presentedViewController { controller = presented }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        controller.present(alert, animated: true)
        #else
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        if let window = webView.window {
            alert.beginSheetModal(for: window) { _ in completionHandler() }
        } else {
            _ = alert.runModal()
            completionHandler()
        }
        #endif
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        #if canImport(UIKit)
        guard var controller = webView.window?.rootViewController else {
            completionHandler(nil)
            return
        }
        while let presented = controller.presentedViewController { controller = presented }
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text)
        })
        controller.present(alert, animated: true)
        #else
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
        alert.accessoryView = field
        let finish: (NSApplication.ModalResponse) -> Void = { response in
            completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
        if let window = webView.window {
            alert.beginSheetModal(for: window, completionHandler: finish)
        } else {
            finish(alert.runModal())
        }
        #endif
    }
}

#if canImport(UIKit)
private struct SettingsWebView: UIViewRepresentable {
    @Binding var loading: Bool
    @Binding var error: String?
    let onAuthenticationFailure: () -> Void
    let onOpenSession: (String) -> Void

    func makeCoordinator() -> SettingsWebCoordinator {
        let loading = $loading
        let error = $error
        let config = ServerConfig.shared
        return SettingsWebCoordinator(
            baseURL: config.baseURL!,
            token: config.token,
            setLoading: { loading.wrappedValue = $0 },
            setError: { error.wrappedValue = $0 },
            onAuthenticationFailure: onAuthenticationFailure,
            onOpenSession: onOpenSession
        )
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        context.coordinator.load(webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
#else
private struct SettingsWebView: NSViewRepresentable {
    @Binding var loading: Bool
    @Binding var error: String?
    let onAuthenticationFailure: () -> Void
    let onOpenSession: (String) -> Void

    func makeCoordinator() -> SettingsWebCoordinator {
        let loading = $loading
        let error = $error
        let config = ServerConfig.shared
        return SettingsWebCoordinator(
            baseURL: config.baseURL!,
            token: config.token,
            setLoading: { loading.wrappedValue = $0 },
            setError: { error.wrappedValue = $0 },
            onAuthenticationFailure: onAuthenticationFailure,
            onOpenSession: onOpenSession
        )
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        context.coordinator.load(webView)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}
}
#endif
