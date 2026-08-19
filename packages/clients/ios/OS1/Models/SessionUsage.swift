import Foundation

/// Cumulative token and cost accounting for one session, as the server folds
/// it (`SessionUsage` in packages/core/protocol). It rides on the session row and
/// is pushed live during a run by the `usage_update` frame.
///
/// Every field has a zero default: a server that predates one of them, or a
/// session that has never run, has to read as "nothing spent yet" rather than
/// fail to decode.
struct SessionUsage: Decodable, Equatable, Hashable, Sendable {
    var costUsd: Double = 0
    var inputTokens: Int = 0
    var outputTokens: Int = 0
    var cacheReadTokens: Int = 0
    var cacheCreationTokens: Int = 0
    /// The most recent turn's whole prompt — what the window currently holds.
    var contextTokens: Int = 0
    /// The token ceiling of the model that produced `contextTokens`. Zero
    /// where the engine didn't report one, which hides the context readout
    /// rather than showing a percentage of nothing.
    var contextWindow: Int = 0
    /// Completed turns folded into these totals.
    var turns: Int = 0
    var updatedAt: String?

    private enum CodingKeys: String, CodingKey {
        case costUsd, inputTokens, outputTokens, cacheReadTokens
        case cacheCreationTokens, contextTokens, contextWindow, turns, updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        costUsd = try container.decodeIfPresent(Double.self, forKey: .costUsd) ?? 0
        inputTokens = try container.decodeIfPresent(Int.self, forKey: .inputTokens) ?? 0
        outputTokens = try container.decodeIfPresent(Int.self, forKey: .outputTokens) ?? 0
        cacheReadTokens =
            try container.decodeIfPresent(Int.self, forKey: .cacheReadTokens) ?? 0
        cacheCreationTokens =
            try container.decodeIfPresent(Int.self, forKey: .cacheCreationTokens) ?? 0
        contextTokens = try container.decodeIfPresent(Int.self, forKey: .contextTokens) ?? 0
        contextWindow = try container.decodeIfPresent(Int.self, forKey: .contextWindow) ?? 0
        turns = try container.decodeIfPresent(Int.self, forKey: .turns) ?? 0
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
    }

    /// For tests and the empty state a menu renders before the first run.
    init(
        costUsd: Double = 0,
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        cacheReadTokens: Int = 0,
        cacheCreationTokens: Int = 0,
        contextTokens: Int = 0,
        contextWindow: Int = 0,
        turns: Int = 0,
        updatedAt: String? = nil
    ) {
        self.costUsd = costUsd
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheCreationTokens = cacheCreationTokens
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.turns = turns
        self.updatedAt = updatedAt
    }
}

// MARK: - Display

/// The formatting is a deliberate copy of the web's `UsageMeter.tsx`, down to
/// the thresholds: the same conversation read on a phone and in a browser has
/// to say the same number, or one of the two is quietly wrong. The grouping
/// and decimal marks follow the reader's locale, as the web's own
/// `Intl.NumberFormat(undefined, …)` does — which is why every entry point
/// takes a locale instead of baking one in.
extension SessionUsage {
    /// `$0.00` at nothing, `<$0.01` for a fraction of a cent, two decimals
    /// under $100, whole dollars above it.
    static func costLabel(_ amount: Double, locale: Locale = .autoupdatingCurrent) -> String {
        if amount <= 0 { return "$0.00" }
        if amount < 0.01 { return "<$0.01" }
        if amount < 100 { return String(format: "$%.2f", amount) }
        return "$" + Int(amount.rounded()).formatted(.number.locale(locale))
    }

    /// Exact under a thousand, compact above it — `45.3K`, `1.2M`.
    static func tokenLabel(_ count: Int, locale: Locale = .autoupdatingCurrent) -> String {
        if count < 1_000 { return String(count) }
        return count.formatted(
            .number.notation(.compactName)
                .precision(.fractionLength(0...1))
                .locale(locale)
        )
    }

    func costLabel(locale: Locale = .autoupdatingCurrent) -> String {
        Self.costLabel(costUsd, locale: locale)
    }

    /// `128.4K / 200K (64%)`, or nil when the engine reported no window —
    /// a percentage of an unknown ceiling means nothing.
    func contextLabel(locale: Locale = .autoupdatingCurrent) -> String? {
        guard contextWindow > 0 else { return nil }
        let fraction = min(Double(contextTokens) / Double(contextWindow), 1)
        return "\(Self.tokenLabel(contextTokens, locale: locale))"
            + " / \(Self.tokenLabel(contextWindow, locale: locale))"
            + " (\(Int((fraction * 100).rounded()))%)"
    }

    /// True once the window is nearly full — the point the web turns its
    /// readout red rather than leaving it as dim chrome.
    var contextIsTight: Bool {
        guard contextWindow > 0 else { return false }
        return Double(contextTokens) / Double(contextWindow) >= 0.85
    }

    /// Share of everything sent that the provider served from cache.
    var cacheHitPercent: Int {
        let total = inputTokens + cacheReadTokens + cacheCreationTokens
        guard total > 0 else { return 0 }
        return Int((Double(cacheReadTokens) / Double(total) * 100).rounded())
    }

    func cacheReadLabel(locale: Locale = .autoupdatingCurrent) -> String {
        "\(Self.tokenLabel(cacheReadTokens, locale: locale)) (\(cacheHitPercent)%)"
    }

    var turnsLabel: String { "\(turns) turn\(turns == 1 ? "" : "s")" }
}
