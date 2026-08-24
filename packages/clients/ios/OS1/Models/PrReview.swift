import Foundation

/// The immutable PR patch and GitHub's per-viewer viewed-file state. These are
/// intentionally separate: changing viewed state must not require reloading a
/// potentially large patch.
struct PrDiff: Decodable, Sendable, Equatable {
    let number: Int
    let baseRefOid: String?
    let headRefOid: String?
    let patch: String
    let diffVersion: String?
    let skippedFiles: Int?
}

struct PrViewedFiles: Decodable, Sendable, Equatable {
    let prId: String
    let viewed: [String]
}

struct PrInlineComment: Hashable, Sendable, Identifiable {
    let path: String
    /// GitHub's line number on the new (right) side of the diff.
    let line: Int
    let text: String

    var id: String { "\(path):\(line)" }
}

struct PrPatchFile: Hashable, Sendable, Identifiable {
    let path: String
    let lines: [PrPatchLine]

    var id: String { path }
}

struct PrPatchLine: Hashable, Sendable, Identifiable {
    enum Kind: Hashable, Sendable { case context, addition, deletion, metadata }

    let id: Int
    let oldLine: Int?
    let newLine: Int?
    let text: String
    let kind: Kind

    /// GitHub only accepts comment anchors on the right side of a changed
    /// diff. Context and added lines have a new-side line number.
    var commentLine: Int? {
        guard kind != .deletion else { return nil }
        return newLine
    }
}

enum PrPatchParser {
    static func files(in patch: String) -> [PrPatchFile] {
        var files: [PrPatchFile] = []
        var path: String?
        var lines: [PrPatchLine] = []
        var oldLine: Int?
        var newLine: Int?

        func flush() {
            guard let path else { return }
            files.append(PrPatchFile(path: path, lines: lines))
            lines = []
            oldLine = nil
            newLine = nil
        }

        for rawLine in patch.split(separator: "\n", omittingEmptySubsequences: false) {
            let text = String(rawLine)
            if text.hasPrefix("diff --git ") {
                flush()
                path = nil
                continue
            }
            if text.hasPrefix("+++ ") {
                let value = String(text.dropFirst(4))
                if value != "/dev/null" {
                    path = cleanedPath(value)
                }
                continue
            }
            if text.hasPrefix("--- ") && path == nil {
                let value = String(text.dropFirst(4))
                if value != "/dev/null" {
                    path = cleanedPath(value)
                }
                continue
            }
            if let hunk = hunkStart(text) {
                oldLine = hunk.old
                newLine = hunk.new
                lines.append(PrPatchLine(
                    id: lines.count,
                    oldLine: nil,
                    newLine: nil,
                    text: text,
                    kind: .metadata
                ))
                continue
            }

            let kind: PrPatchLine.Kind
            let old: Int?
            let new: Int?
            if let currentOld = oldLine, let currentNew = newLine {
                if text.hasPrefix("+") && !text.hasPrefix("+++") {
                    kind = .addition
                    old = nil
                    new = currentNew
                    newLine = currentNew + 1
                } else if text.hasPrefix("-") && !text.hasPrefix("---") {
                    kind = .deletion
                    old = currentOld
                    new = nil
                    oldLine = currentOld + 1
                } else {
                    kind = .context
                    old = currentOld
                    new = currentNew
                    oldLine = currentOld + 1
                    newLine = currentNew + 1
                }
            } else {
                kind = .metadata
                old = nil
                new = nil
            }
            lines.append(PrPatchLine(
                id: lines.count,
                oldLine: old,
                newLine: new,
                text: text,
                kind: kind
            ))
        }
        flush()
        return files
    }

    private static func cleanedPath(_ value: String) -> String {
        let path = value.split(separator: "\t", maxSplits: 1).first.map(String.init) ?? value
        return path.hasPrefix("a/") || path.hasPrefix("b/") ? String(path.dropFirst(2)) : path
    }

    private static func hunkStart(_ line: String) -> (old: Int, new: Int)? {
        guard line.hasPrefix("@@ ") else { return nil }
        let values = line.split(separator: " ")
        guard values.count >= 3,
              let old = number(in: values[1]),
              let new = number(in: values[2]) else { return nil }
        return (old, new)
    }

    private static func number(in range: Substring) -> Int? {
        let value = range.dropFirst().split(separator: ",", maxSplits: 1).first
        return value.flatMap { Int($0) }
    }
}

// MARK: - How the diff is drawn

/// Unified or side by side. The persisted native rendering preferences that
/// use this value are shared by pull request review and worktree Changes.
enum PrDiffStyle: String, CaseIterable, Sendable {
    case unified, split

    var label: String {
        switch self {
        case .unified: "Unified diff"
        case .split: "Split diff"
        }
    }

    var symbol: String {
        switch self {
        case .unified: "list.bullet.rectangle"
        case .split: "rectangle.split.2x1"
        }
    }
}

/// One row of a side-by-side diff. A hunk header spans both columns; a
/// changed run pairs its deletions against its additions and pads the shorter
/// side, which is what keeps the two columns reading as one change.
struct PrPatchRow: Identifiable, Hashable, Sendable {
    let id: Int
    let left: PrPatchLine?
    let right: PrPatchLine?
    /// Set when the row is a full-width hunk header rather than a pair.
    let header: PrPatchLine?
}

extension PrPatchParser {
    /// Pair a file's unified lines into side-by-side rows.
    static func rows(_ lines: [PrPatchLine]) -> [PrPatchRow] {
        var rows: [PrPatchRow] = []
        var deletions: [PrPatchLine] = []
        var additions: [PrPatchLine] = []

        func flushRun() {
            guard !deletions.isEmpty || !additions.isEmpty else { return }
            for index in 0..<max(deletions.count, additions.count) {
                rows.append(PrPatchRow(
                    id: rows.count,
                    left: index < deletions.count ? deletions[index] : nil,
                    right: index < additions.count ? additions[index] : nil,
                    header: nil
                ))
            }
            deletions = []
            additions = []
        }

        for line in lines {
            switch line.kind {
            case .deletion: deletions.append(line)
            case .addition: additions.append(line)
            case .metadata:
                flushRun()
                rows.append(PrPatchRow(id: rows.count, left: nil, right: nil, header: line))
            case .context:
                flushRun()
                rows.append(PrPatchRow(id: rows.count, left: line, right: line, header: nil))
            }
        }
        flushRun()
        return rows
    }
}

// MARK: - The other two lenses

/// The generated review guide: the diff grouped into a handful of sections to
/// read in order. The server answers `null` when there is no PR or generation
/// failed, and the canvas falls back to the plain diff.
struct PrReviewGuide: Decodable, Sendable, Equatable {
    struct Section: Decodable, Sendable, Equatable, Identifiable {
        let title: String
        let explanation: String
        let files: [String]

        var id: String { "\(title)|\(files.joined(separator: ","))" }
    }

    let number: Int?
    let headRefOid: String?
    let sections: [Section]
}

/// The structural call/branch trees behind a change. `status` stays a plain
/// string so a value this build has never heard of decodes rather than
/// throwing away the whole tree.
struct PrCodeFlow: Decodable, Sendable, Equatable {
    struct Tree: Decodable, Sendable, Equatable, Identifiable {
        let entry: String
        let tree: PrCodeFlowNode

        var id: String { entry }
    }

    let trees: [Tree]
    let languages: [String]?
    let skippedFiles: Int?
    let truncated: Bool?
}

struct PrCodeFlowNode: Decodable, Sendable, Equatable, Hashable, Identifiable {
    let key: String
    let label: String
    let kind: String?
    let status: String
    let file: String?
    let line: Int?
    let children: [PrCodeFlowNode]

    var id: String { "\(key):\(status):\(file ?? ""):\(line ?? 0)" }

    /// The one-character mark the web draws in front of a node.
    var mark: String {
        switch status {
        case "added": "+"
        case "removed": "−"
        case "modified": "~"
        default: "·"
        }
    }

    var isUnchanged: Bool { status == "same" }
}
