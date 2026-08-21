import Foundation

protocol CodeFenceClipboard {
    func write(_ text: String)
}

struct MarkdownCodeFence: Equatable {
    let language: String
    let contents: String

    func copy(to clipboard: some CodeFenceClipboard) {
        clipboard.write(contents)
    }
}

enum MarkdownCodeFenceSegment: Equatable {
    case markdown(String)
    case fence(MarkdownCodeFence)
}

enum MarkdownCodeFenceParser {
    private struct Opening {
        let marker: Character
        let length: Int
        let indentation: Int
        let language: String
    }

    static func split(_ markdown: String) -> [MarkdownCodeFenceSegment] {
        let lines = markdown.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var segments: [MarkdownCodeFenceSegment] = []
        var markdownStart = 0
        var index = 0

        while index < lines.count {
            guard let opening = opening(in: lines[index]) else {
                index += 1
                continue
            }
            // Once an opening fence is seen, every later line belongs to it
            // until a matching close. A shorter nested-looking fence is code,
            // not a new block that can be extracted independently.
            guard let closingIndex = closingIndex(
                in: lines,
                after: index,
                opening: opening
            ) else {
                break
            }

            appendMarkdown(lines[markdownStart..<index], to: &segments)
            let code = lines[(index + 1)..<closingIndex]
                .map { removeIndentation(from: $0, count: opening.indentation) }
                .joined(separator: "\n")
            segments.append(.fence(.init(language: opening.language, contents: code)))
            index = closingIndex + 1
            markdownStart = index
        }

        appendMarkdown(lines[markdownStart..<lines.count], to: &segments)
        return segments.isEmpty ? [.markdown(markdown)] : segments
    }

    private static func opening(in line: String) -> Opening? {
        let indentation = line.prefix(while: { $0 == " " }).count
        guard indentation <= 3 else { return nil }

        let body = line.dropFirst(indentation)
        guard let marker = body.first, marker == "`" || marker == "~" else { return nil }
        let length = body.prefix(while: { $0 == marker }).count
        guard length >= 3 else { return nil }

        let info = String(body.dropFirst(length)).trimmingCharacters(in: .whitespaces)
        guard marker != "`" || !info.contains("`") else { return nil }
        let language = info.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
        return Opening(marker: marker, length: length, indentation: indentation, language: language)
    }

    private static func closingIndex(
        in lines: [String],
        after openingIndex: Int,
        opening: Opening
    ) -> Int? {
        lines.indices.dropFirst(openingIndex + 1).first { index in
            isClosing(lines[index], opening: opening)
        }
    }

    private static func isClosing(_ line: String, opening: Opening) -> Bool {
        let indentation = line.prefix(while: { $0 == " " }).count
        guard indentation <= 3 else { return false }

        let body = line.dropFirst(indentation)
        let markerLength = body.prefix(while: { $0 == opening.marker }).count
        guard markerLength >= opening.length else { return false }
        return body.dropFirst(markerLength).allSatisfy { $0.isWhitespace }
    }

    private static func removeIndentation(from line: String, count: Int) -> String {
        let removable = line.prefix(count).prefix(while: { $0 == " " }).count
        return String(line.dropFirst(removable))
    }

    private static func appendMarkdown(
        _ lines: ArraySlice<String>,
        to segments: inout [MarkdownCodeFenceSegment]
    ) {
        guard !lines.isEmpty else { return }
        let markdown = lines.joined(separator: "\n")
        guard !markdown.isEmpty else { return }
        segments.append(.markdown(markdown))
    }
}

#if os(iOS)
import UIKit

struct SystemCodeFenceClipboard: CodeFenceClipboard {
    func write(_ text: String) {
        UIPasteboard.general.string = text
    }
}
#elseif os(macOS)
import AppKit

struct SystemCodeFenceClipboard: CodeFenceClipboard {
    func write(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
#endif
