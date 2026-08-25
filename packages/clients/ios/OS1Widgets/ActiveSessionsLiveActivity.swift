import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

struct ActiveSessionsLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ActiveSessionsAttributes.self) { context in
            ActiveSessionsLockScreen(context: context)
                .activityBackgroundTint(WidgetStyle.background)
                .activitySystemActionForegroundColor(WidgetStyle.text)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        if context.state.totalCount > 0 {
                            Label(
                                context.state.totalCount == 1
                                    ? "1 active"
                                    : "\(context.state.totalCount) active",
                                systemImage: "bolt.horizontal.circle.fill"
                            )
                            .font(.headline)
                            if context.state.unreadCount > 0 {
                                Text(
                                    context.state.unreadCount == 1
                                        ? "1 unread"
                                        : "\(context.state.unreadCount) unread"
                                )
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }
                        } else if context.state.unreadCount > 0 {
                            Label(
                                context.state.unreadCount == 1
                                    ? "1 unread"
                                    : "\(context.state.unreadCount) unread",
                                systemImage: "tray.full.fill"
                            )
                            .font(.headline)
                        } else {
                            Label("Caught up", systemImage: "checkmark.circle.fill")
                                .font(.headline)
                        }
                    }
                    .privacySensitive()
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if let startedAt = context.state.sessions.first?.startedAt {
                        Text(Date(timeIntervalSince1970: startedAt), style: .timer)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .privacySensitive()
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if context.state.sessions.isEmpty, context.state.unreadCount > 0 {
                        Label(
                            context.state.unreadCount == 1
                                ? "1 session ready to review"
                                : "\(context.state.unreadCount) sessions ready to review",
                            systemImage: "tray.full.fill"
                        )
                        .font(.subheadline)
                        .privacySensitive()
                        .frame(maxWidth: .infinity, alignment: .leading)
                    } else if context.state.sessions.isEmpty {
                        Text("All caught up")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        ActiveSessionRows(snapshot: context.state, compact: true)
                    }
                }
            } compactLeading: {
                ZStack(alignment: .topTrailing) {
                    Image(
                        systemName: context.state.totalCount > 0
                            ? "bolt.horizontal.fill"
                            : context.state.unreadCount > 0
                                ? "tray.full.fill"
                                : "checkmark"
                    )
                    .foregroundStyle(WidgetStyle.accent)
                    if context.state.totalCount > 0, context.state.unreadCount > 0 {
                        Circle()
                            .fill(WidgetStyle.accent)
                            .frame(width: 5, height: 5)
                            .offset(x: 3, y: -2)
                    }
                }
                .accessibilityLabel(compactAccessibilityLabel(for: context.state))
            } compactTrailing: {
                Text(
                    context.state.totalCount > 0
                        ? "\(context.state.totalCount)"
                        : context.state.unreadCount > 0
                            ? "\(context.state.unreadCount)"
                            : ""
                )
                .font(.caption.monospacedDigit().weight(.semibold))
                .privacySensitive()
            } minimal: {
                ZStack(alignment: .topTrailing) {
                    Image(
                        systemName: context.state.totalCount > 0
                            ? "bolt.horizontal.fill"
                            : context.state.unreadCount > 0
                                ? "tray.full.fill"
                                : "checkmark"
                    )
                    .foregroundStyle(WidgetStyle.accent)
                    if context.state.totalCount > 0, context.state.unreadCount > 0 {
                        Circle()
                            .fill(WidgetStyle.accent)
                            .frame(width: 5, height: 5)
                            .offset(x: 3, y: -2)
                    }
                }
                .accessibilityLabel(compactAccessibilityLabel(for: context.state))
            }
            .keylineTint(WidgetStyle.accent)
        }
    }

    private func compactAccessibilityLabel(for snapshot: ActiveSessionsSnapshot) -> String {
        if snapshot.totalCount == 0, snapshot.unreadCount == 0 { return "All caught up" }
        let active = snapshot.totalCount == 1
            ? "1 active session"
            : "\(snapshot.totalCount) active sessions"
        guard snapshot.unreadCount > 0 else { return active }
        let unread = snapshot.unreadCount == 1
            ? "1 unread session"
            : "\(snapshot.unreadCount) unread sessions"
        return snapshot.totalCount > 0 ? "\(active), \(unread)" : unread
    }
}

private struct ActiveSessionsLockScreen: View {
    let context: ActivityViewContext<ActiveSessionsAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(
                    systemName: context.isStale
                        ? "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90"
                        : context.state.totalCount > 0
                            ? "bolt.horizontal.circle.fill"
                            : "tray.full.fill"
                )
                .foregroundStyle(context.isStale ? .secondary : WidgetStyle.accent)
                Text(header)
                    .font(.headline)
                    .privacySensitive()
                Spacer(minLength: 8)
                if let startedAt = context.state.sessions.first?.startedAt,
                   !context.state.sessions.isEmpty {
                    Text(Date(timeIntervalSince1970: startedAt), style: .timer)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .privacySensitive()
                }
            }

            if context.state.sessions.isEmpty {
                Text(emptyMessage)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .privacySensitive()
            } else {
                ActiveSessionRows(snapshot: context.state, compact: false)
                if context.state.unreadCount > 0 {
                    Label(
                        context.state.unreadCount == 1
                            ? "1 unread session"
                            : "\(context.state.unreadCount) unread sessions",
                        systemImage: "tray.full.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .privacySensitive()
                }
            }
        }
        .padding(14)
    }

    private var header: String {
        if context.isStale { return "Activity may be out of date" }
        if context.state.totalCount == 0, context.state.unreadCount == 0 {
            return "All caught up"
        }
        if context.state.totalCount == 0 {
            return context.state.unreadCount == 1
                ? "1 unread session"
                : "\(context.state.unreadCount) unread sessions"
        }
        return context.state.totalCount == 1
            ? "1 active session"
            : "\(context.state.totalCount) active sessions"
    }

    private var emptyMessage: String {
        context.state.unreadCount > 0
            ? "Ready to review in OS"
            : "All caught up"
    }
}

private struct ActiveSessionRows: View {
    let snapshot: ActiveSessionsSnapshot
    let compact: Bool

    var body: some View {
        VStack(spacing: compact ? 5 : 7) {
            ForEach(snapshot.sessions) { session in
                Button(intent: OpenSessionIntent(sessionId: session.id)) {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(WidgetStyle.accent)
                            .frame(width: 6, height: 6)
                        Text(session.title)
                            .font(compact ? .caption : .subheadline)
                            .fontWeight(.medium)
                            .lineLimit(1)
                            .privacySensitive()
                        Spacer(minLength: 6)
                        Text(session.repo)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .privacySensitive()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .privacySensitive()
                .accessibilityLabel("Open active session")
            }

            if snapshot.totalCount > snapshot.sessions.count {
                Text("+\(snapshot.totalCount - snapshot.sessions.count) more")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .privacySensitive()
            }
        }
    }
}
