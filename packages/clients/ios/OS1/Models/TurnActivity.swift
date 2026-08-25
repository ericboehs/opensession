import Foundation

/// How a turn's work reads in the transcript, as two independent choices.
struct TurnActivity: Equatable {
    enum Work: String {
        case folded
        case running
        case open
    }

    enum Tools: String {
        case folded
        case open
    }

    var work: Work = .running
    var tools: Tools = .folded

    static let standard = TurnActivity()

    init(work rawWork: String?, tools rawTools: String?) {
        let legacy = rawWork.flatMap { Self.legacy[$0] }
        self.work = Work(rawValue: rawWork ?? "") ?? legacy?.work ?? .running
        self.tools = Tools(rawValue: rawTools ?? "") ?? legacy?.tools ?? .folded
    }

    init(work: Work = .running, tools: Tools = .folded) {
        self.work = work
        self.tools = tools
    }

    static let legacy: [String: TurnActivity] = [
        "messages": TurnActivity(work: .open, tools: .folded),
        "collapsed": TurnActivity(work: .folded, tools: .folded),
        "auto": TurnActivity(work: .running, tools: .folded),
        "expanded": TurnActivity(work: .open, tools: .open),
    ]

    /// Merge a server patch over this device's cache. A legacy work value owns
    /// both controls when the server has no separate tool-call value yet.
    static func mergingRemote(
        work rawWork: String?,
        tools rawTools: String?,
        local: TurnActivity
    ) -> TurnActivity {
        let old = rawWork.flatMap { legacy[$0] }
        return TurnActivity(
            work: Work(rawValue: rawWork ?? "") ?? old?.work ?? local.work,
            tools: Tools(rawValue: rawTools ?? "") ?? old?.tools ?? local.tools
        )
    }

    func defaultExpanded(isLive: Bool) -> Bool {
        work == .open || (work == .running && isLive)
    }

    /// Whether grouped tool runs render every call in place instead of behind
    /// their compact step row. It never opens a call's own body: that stays
    /// behind the row's disclosure either way, as it does on the web.
    var rendersToolCallsInPlace: Bool {
        tools == .open
    }
}
