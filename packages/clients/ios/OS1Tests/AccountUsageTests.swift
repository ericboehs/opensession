import XCTest
@testable import OS1

/// The Usage page reads three or four limits per account and draws each one.
/// Getting the reading wrong is invisible in a screenshot — a stale window
/// still draws a plausible bar — so the rules are tested rather than eyeballed.
final class AccountUsageTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func window(_ label: String, _ utilization: Double?, resets: TimeInterval? = nil, scoped: Bool = false) -> LimitWindow {
        LimitWindow(
            label: label,
            utilization: utilization,
            resetsAt: resets.map { ISO8601DateFormatter().string(from: now.addingTimeInterval($0)) },
            scoped: scoped
        )
    }

    func testEveryLimitWithANumberIsDrawn() {
        let live = AccountUsageReading.liveLimits(
            [window("5h", 12), window("7d", 84), window("Fable", 40, scoped: true)],
            now: now
        )
        XCTAssertEqual(live.map(\.label), ["5h", "7d", "Fable"])
        XCTAssertEqual(live.map(\.utilization), [12, 84, 40])
    }

    /// A per-model cap holds up one model rather than the account, so it reads
    /// after the account's own windows.
    func testPerModelCapsComeAfterTheAccountsOwnWindows() {
        let live = AccountUsageReading.liveLimits(
            [window("Spark 1w", 0, scoped: true), window("Codex 1w", 82)],
            now: now
        )
        XCTAssertEqual(live.map(\.label), ["Codex 1w", "Spark 1w"])
    }

    /// "Unknown" and "nothing used" are different states: a token that cannot
    /// read usage must not draw an empty bar.
    func testWindowsWithoutANumberAreLeftOutRatherThanDrawnEmpty() {
        let live = AccountUsageReading.liveLimits([window("5h", nil), window("7d", 3)], now: now)
        XCTAssertEqual(live.map(\.label), ["7d"])
        XCTAssertTrue(AccountUsageReading.liveLimits([window("5h", nil)], now: now).isEmpty)
    }

    /// A window whose reset has already passed is provably stale. Counting it
    /// at its last value would pin a just-reset account at 100% until the next
    /// poll.
    func testAPassedResetCountsAsEmpty() {
        let stale = window("5h", 100, resets: -60)
        XCTAssertEqual(AccountUsageReading.liveUtilization(stale, now: now), 0)

        let live = AccountUsageReading.liveLimits([stale, window("7d", 20)], now: now)
        XCTAssertEqual(live.map(\.utilization), [0, 20])
    }

    /// Utilization arrives as 0-100, the same scale the web meter takes.
    /// Reading it as a fraction printed every busy account as "10000%".
    func testUtilizationIsAPercentageNotAFraction() {
        XCTAssertEqual(AccountUsageReading.percentLabel(98), "98%")
        XCTAssertEqual(AccountUsageReading.fraction(98), 0.98, accuracy: 0.0001)
        XCTAssertEqual(AccountUsageReading.fraction(140), 1, accuracy: 0.0001)
        XCTAssertEqual(AccountUsageReading.fraction(nil), 0, accuracy: 0.0001)
    }

    func testColourOnlyMeansRunningOut() {
        XCTAssertFalse(AccountUsageReading.isWarning(69))
        XCTAssertTrue(AccountUsageReading.isWarning(70))
        XCTAssertFalse(AccountUsageReading.isNearLimit(89))
        XCTAssertTrue(AccountUsageReading.isNearLimit(90))
    }

    /// What a person wants from a limit is how long until it frees up.
    func testResetReadsAsTimeRemaining() {
        XCTAssertEqual(AccountUsageReading.formatReset(iso(now.addingTimeInterval(1800)), now: now), "resets in 30m")
        XCTAssertEqual(AccountUsageReading.formatReset(iso(now.addingTimeInterval(7200)), now: now), "resets in 2h")
        XCTAssertEqual(AccountUsageReading.formatReset(iso(now.addingTimeInterval(86400 * 3)), now: now), "resets in 3d")
        XCTAssertEqual(AccountUsageReading.formatReset(iso(now.addingTimeInterval(-60)), now: now), "resets now")
        XCTAssertNil(AccountUsageReading.formatReset(nil, now: now))
    }

    func testClaudeLimitsCarryTheRollingWindowsAndTheScopedCaps() {
        let usage = AccountUsage(
            fiveHour: UsageWindow(utilization: 10, resetsAt: nil),
            sevenDay: UsageWindow(utilization: 20, resetsAt: nil),
            scopedLimits: [ScopedUsageLimit(label: "Fable", utilization: 30, resetsAt: nil)]
        )
        let limits = AccountUsageReading.claudeLimits(usage)
        XCTAssertEqual(limits.map(\.label), ["5h", "7d", "Fable"])
        XCTAssertEqual(limits.filter(\.scoped).map(\.label), ["Fable"])
    }

    /// Both of a bucket's windows carry its name, so the length is what tells
    /// them apart. With one bucket the name adds nothing and the length stands
    /// alone, as it does on the web.
    func testCodexLimitsAreNamedForTheirWindowLength() {
        let oneBucket = AccountUsage(
            buckets: [
                CodexUsageBucket(
                    id: "codex",
                    primary: UsageWindow(utilization: 40, resetsAt: nil, windowDurationMins: 300),
                    secondary: UsageWindow(utilization: 90, resetsAt: nil, windowDurationMins: 10_080)
                )
            ]
        )
        XCTAssertEqual(AccountUsageReading.codexLimits(oneBucket).map(\.label), ["5h", "1w"])

        let twoBuckets = AccountUsage(
            buckets: [
                CodexUsageBucket(
                    id: "codex",
                    primary: UsageWindow(utilization: 82, resetsAt: nil, windowDurationMins: 10_080)
                ),
                CodexUsageBucket(
                    id: "spark",
                    label: "GPT-5.3-Codex-Spark",
                    primary: UsageWindow(utilization: 0, resetsAt: nil, windowDurationMins: 10_080)
                ),
            ]
        )
        let limits = AccountUsageReading.codexLimits(twoBuckets)
        XCTAssertEqual(limits.map(\.label), ["codex 1w", "GPT-5.3-Codex-Spark 1w"])
        // The named bucket is a per-model budget, so it sorts after the plan's
        // own window even though both windows are the same length.
        XCTAssertEqual(limits.filter(\.scoped).map(\.label), ["GPT-5.3-Codex-Spark 1w"])
    }

    /// Every field is optional, as everywhere else in this client: a server
    /// that reports a shape this build has never seen still decodes.
    func testUsageDecodesFromAPartialPayload() throws {
        let json = Data(#"{"fetchedAt":"2026-08-16T10:00:00Z","fiveHour":{"utilization":42}}"#.utf8)
        let usage = try JSONDecoder().decode(AccountUsage.self, from: json)
        XCTAssertEqual(usage.fiveHour?.utilization, 42)
        XCTAssertNil(usage.sevenDay)
        XCTAssertNil(usage.buckets)
    }

    private func iso(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}
