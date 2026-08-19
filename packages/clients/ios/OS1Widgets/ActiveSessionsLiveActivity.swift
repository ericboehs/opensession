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
                Label(
                    "\(context.state.totalCount) active",
                    systemImage: "bolt.horizontal.circle.fill"
                )
                .font(.headline)
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
                    ActiveSessionRows(snapshot: context.state, compact: true)
                }
            } compactLeading: {
                Image(systemName: "bolt.horizontal.fill")
                    .foregroundStyle(WidgetStyle.accent)
            } compactTrailing: {
            Text("\(context.state.totalCount)")
                .font(.caption.monospacedDigit().weight(.semibold))
                .privacySensitive()
            } minimal: {
                Image(systemName: "bolt.horizontal.fill")
                    .foregroundStyle(WidgetStyle.accent)
            }
            .keylineTint(WidgetStyle.accent)
        }
    }
}

private struct ActiveSessionsLockScreen: View {
    let context: ActivityViewContext<ActiveSessionsAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: context.isStale
                    ? "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90"
                    : "bolt.horizontal.circle.fill")
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
                Text("All sessions finished")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ActiveSessionRows(snapshot: context.state, compact: false)
            }
        }
        .padding(14)
    }

    private var header: String {
        if context.isStale { return "Activity may be out of date" }
        return context.state.totalCount == 1
            ? "1 active session"
            : "\(context.state.totalCount) active sessions"
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
