import SwiftUI
#if os(iOS)
import WebKit

/// What the automations published while you were away.
///
/// Each row is one automation and the document it last wrote — the morning
/// support digest, the error sweep, the review that runs every hour. Tapping
/// it opens that document, because reading it is the entire job: the report is
/// long-form prose an agent wrote for a person, and everything this app could
/// put around it is in the way of it.
///
/// Two levels, not three. The web keeps a history column beside the document
/// and picks the newest for you; on a phone a second list of dates between the
/// row and the reading is a tax on the common case, which is "show me today's".
/// The older ones are a menu in the document's own bar, where they are one tap
/// away from the thing they are alternatives to.
struct ReportsListView: View {
    @State private var groups: [ReportGroup] = []
    @State private var loading = true
    @State private var loadFailed = false

    var body: some View {
        Group {
            if loading && groups.isEmpty {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if loadFailed && groups.isEmpty {
                failedPlaceholder
            } else if groups.isEmpty {
                emptyPlaceholder
            } else {
                list
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OS1VisualStyle.background)
        .navigationTitle("Reports")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private var list: some View {
        List {
            Section {
                ForEach(groups) { group in
                    NavigationLink(value: ReportRoute(group: group)) {
                        ReportGroupRow(group: group)
                    }
                }
            } footer: {
                Text("Recurring documents your automations publish. Opening one shows its newest; the rest are in its history.")
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(OS1VisualStyle.background)
        .refreshable { await load() }
        .navigationDestination(for: ReportRoute.self) { route in
            ReportDocumentView(group: route.group)
        }
    }

    private var emptyPlaceholder: some View {
        ListPlaceholder(
            symbol: "text.document",
            title: "No reports",
            message: "Recurring documents your automations publish collect here."
        ) {
            EmptyView()
        }
    }

    private var failedPlaceholder: some View {
        ListPlaceholder(
            symbol: "exclamationmark.triangle",
            title: "Couldn't load reports",
            message: "The server didn't answer for the published reports."
        ) {
            Button("Try again") { Task { await load() } }
                .buttonStyle(PlaceholderActionStyle())
        }
    }

    private func load() async {
        do {
            let next = try await OS1API.reportGroups()
            guard !Task.isCancelled else { return }
            groups = next
            loadFailed = false
        } catch {
            if groups.isEmpty { loadFailed = true }
        }
        loading = false
    }
}

/// A group pushed from the list.
private struct ReportRoute: Hashable {
    let group: ReportGroup
}

/// One automation: its name, what it last said, and when.
///
/// The count is here rather than in the document's bar because it is what
/// tells you there is a history at all — and it is the only number on the row,
/// so it can be read without being counted against anything else.
private struct ReportGroupRow: View {
    let group: ReportGroup

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            // Monochrome, like every other row glyph in the app: hierarchical
            // renders the symbol in two opacities, which reads as a lighter
            // weight than the rows around it.
            Image(systemName: "text.document")
                .font(.callout)
                .foregroundStyle(OS1VisualStyle.textDim)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(group.name)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.text)
                        .lineLimit(1)
                    if let signal = group.latest.signal {
                        ReportSignalBadge(urgency: signal)
                    }
                }
                Text(secondLine)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .lineLimit(2)
                Text(verbatim: metaLine)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
    }

    /// What the automation found, not what it called the document.
    ///
    /// The web's row shows the title. Measured against every group this
    /// instance publishes, all twenty titles are the automation's own name
    /// followed by the date — which the row's first line and its timestamp
    /// already say, so it spends the widest line on the page repeating them.
    /// The summary is where the news is ("71 todo, 30 snoozed, 20 new in 24h"),
    /// and all twenty carry one. The title is the fallback for a report
    /// published without a gist.
    private var secondLine: String {
        let summary = group.latest.summary?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let summary, !summary.isEmpty { return summary }
        return group.latest.title
    }

    /// Built with a formatter rather than interpolated into a `Text` string:
    /// a count in a `LocalizedStringKey` is read as a number to localize, and
    /// a four-digit one comes out with a thousands separator on a Dutch phone.
    private var metaLine: String {
        let reports = group.count == 1 ? "1 report" : "\(group.count) reports"
        guard let published = group.latest.published else { return reports }
        let when = published.formatted(.relative(presentation: .named))
        return "\(when) · \(reports)"
    }
}

/// The urgency word, said once. Confidence is not here: on a row it doubles
/// the badge's width to qualify a signal you have not read yet, and it is in
/// the document's header where it belongs to something.
///
/// The status palette is a set of FILL colours — one pair of values for both
/// appearances, and those values are the web's dark theme, which measures
/// around 2.5:1 against this app's light surfaces. That is fine for a wash
/// and wrong for a word, so the colour is the capsule and the word stays in
/// the ordinary text colour, which reads at full contrast either way.
private struct ReportSignalBadge: View {
    let urgency: ReportUrgency

    var body: some View {
        Text(urgency.label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(OS1VisualStyle.text)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(wash.opacity(0.22), in: Capsule())
    }

    private var wash: Color {
        switch urgency {
        case .critical, .high: OS1VisualStyle.red
        case .medium: OS1VisualStyle.yellow
        case .low, .unknown: OS1VisualStyle.hover
        }
    }
}

/// One automation's newest report, with its history one tap away.
///
/// The document is framed rather than re-rendered natively. It is HTML an
/// agent authored, with its own headings, tables and evidence links, and the
/// route that serves it is also what makes its `assets/…` references resolve.
struct ReportDocumentView: View {
    let group: ReportGroup

    @State private var history: [ReportMeta] = []
    @State private var selected: ReportMeta
    /// A link tapped inside the document, opened over it rather than instead
    /// of it — the same as a link in a transcript.
    @State private var openLink: SafariLink?

    init(group: ReportGroup) {
        self.group = group
        _selected = State(initialValue: group.latest)
    }

    var body: some View {
        Group {
            if let url = OS1API.reportURL(
                automationId: selected.automationId.isEmpty
                    ? group.automationId
                    : selected.automationId,
                reportId: selected.id
            ) {
                ReportWebView(
                    url: url,
                    automationId: group.automationId,
                    reportId: selected.id,
                    onOpenLink: { openLink = SafariLink(url: $0) }
                )
                .id(selected.id)
                .ignoresSafeArea(edges: .bottom)
            } else {
                ListPlaceholder(
                    symbol: "exclamationmark.triangle",
                    title: "Couldn't open this report",
                    message: "The server address isn't set."
                ) {
                    EmptyView()
                }
            }
        }
        .navigationTitle(group.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if history.count > 1 {
                    Menu {
                        Picker("History", selection: $selected) {
                            ForEach(history) { report in
                                Text(verbatim: label(for: report)).tag(report)
                            }
                        }
                    } label: {
                        Label("History", systemImage: "clock.arrow.circlepath")
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if let link = shareURL {
                    ShareLink(item: link) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                }
            }
        }
        .sheet(item: $openLink) { link in
            SafariSheet(url: link.url)
        }
        .task(id: group.automationId) { await loadHistory() }
    }

    private var shareURL: URL? {
        guard let base = ServerConfig.shared.baseURL else { return nil }
        return base
            .appendingPathComponent("reports")
            .appendingPathComponent(group.automationId)
            .appendingPathComponent(selected.id)
    }

    /// What one entry in the history menu says. The date, and the urgency when
    /// there is one, because in a list of dates that is the only thing that
    /// makes an older report worth going back to.
    private func label(for report: ReportMeta) -> String {
        let when = report.published?.formatted(
            .dateTime.month(.abbreviated).day().hour().minute()
        ) ?? report.id
        guard let signal = report.signal else { return when }
        return "\(when) · \(signal.label.lowercased())"
    }

    private func loadHistory() async {
        guard let next = try? await OS1API.reports(automationId: group.automationId) else {
            return
        }
        guard !Task.isCancelled else { return }
        history = next
        // Keep whatever is on screen, but prefer the server's own copy of it:
        // the group's `latest` was captured when the list loaded, and a fresh
        // one may have been published since.
        if let match = next.first(where: { $0.id == selected.id }) {
            selected = match
        } else if let newest = next.first {
            selected = newest
        }
    }
}

/// A report in a web view, loaded from the route that serves it.
///
/// Three things this does that a bare `WKWebView(url:)` would not:
///
/// - Seeds the session token as the same `opensession_auth` cookie the web
///   client uses, scoped to THIS report's path. WebKit does not carry the
///   app's `Authorization` header on subresource loads, and 29 of the 282
///   reports on this instance reference durable evidence as `assets/…`, which
///   would otherwise come back 401 with no sign that anything was missing.
/// - Injects a viewport meta tag. Reports are authored by agents from a
///   handful of house styles and 151 of those 282 carry no viewport of their
///   own, so iOS lays them out at 980pt and scales the result down to a page
///   of unreadably small type. Nothing about the document changes; the phone
///   is told to lay it out at its own width.
/// - Opens links over the report rather than in it. A report is dense with
///   evidence links (165 of 282 carry at least one), and following one in
///   place would replace the document with no way back to it. In-page anchors
///   are left alone, because those are the document navigating itself.
private struct ReportWebView: UIViewRepresentable {
    let url: URL
    let automationId: String
    let reportId: String
    let onOpenLink: (URL) -> Void

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Nothing a report leaves behind should outlive the screen; the
        // cookie is re-seeded on every load anyway.
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(Self.viewportScript)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        // Opaque and white on purpose. A report brings its own colours, and
        // they assume a page under them: handing it a clear background would
        // put an authored dark-on-white document on this app's dark canvas.
        webView.isOpaque = true
        webView.backgroundColor = .white
        webView.scrollView.backgroundColor = .white
        context.coordinator.onOpenLink = onOpenLink
        context.coordinator.load(url, in: webView, automationId: automationId, reportId: reportId)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onOpenLink = onOpenLink
        guard context.coordinator.loaded != url else { return }
        context.coordinator.load(url, in: webView, automationId: automationId, reportId: reportId)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// `atDocumentStart` so the tag is in place before layout, and guarded so
    /// a report that already declares one keeps its own.
    private static let viewportScript = WKUserScript(
        source: """
        (function () {
          if (document.querySelector('meta[name="viewport"]')) return;
          var meta = document.createElement('meta');
          meta.name = 'viewport';
          meta.content = 'width=device-width, initial-scale=1';
          (document.head || document.documentElement).appendChild(meta);
        })();
        """,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        private(set) var loaded: URL?
        var onOpenLink: ((URL) -> Void)?

        /// Seeding has to FINISH before the navigation starts: a cookie set
        /// alongside the load loses the race and the report comes back a 401.
        func load(_ url: URL, in webView: WKWebView, automationId: String, reportId: String) {
            loaded = url
            let token = ServerConfig.shared.token
            guard !token.isEmpty, let cookie = Self.authCookie(
                token: token,
                url: url,
                automationId: automationId,
                reportId: reportId
            ) else {
                // A server running without the auth gate needs no cookie.
                webView.load(URLRequest(url: url))
                return
            }
            let store = webView.configuration.websiteDataStore.httpCookieStore
            Task {
                await store.setCookie(cookie)
                webView.load(URLRequest(url: url))
            }
        }

        private static func authCookie(
            token: String,
            url: URL,
            automationId: String,
            reportId: String
        ) -> HTTPCookie? {
            guard let host = url.host else { return nil }
            var properties: [HTTPCookiePropertyKey: Any] = [
                .name: "opensession_auth",
                .value: token,
                .domain: host,
                // This report and its own assets, and nothing else on the API.
                .path: "/api/reports/\(automationId)/\(reportId)/",
            ]
            if url.scheme == "https" { properties[.secure] = "TRUE" }
            return HTTPCookie(properties: properties)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard navigationAction.navigationType == .linkActivated,
                  let target = navigationAction.request.url
            else {
                decisionHandler(.allow)
                return
            }
            // An anchor into the report itself is the document navigating
            // itself: same page, different place, and it stays here.
            if target.fragment != nil,
               target.absoluteString.hasPrefix(loaded?.absoluteString ?? "") {
                decisionHandler(.allow)
                return
            }
            guard SafariLink.isWeb(target) else {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.cancel)
            onOpenLink?(target)
        }
    }
}
#endif
