import Foundation

/// One file's slice of a worktree's unified patch.
///
/// `GET /api/sessions/:id/diff` answers a file list *and* one `rawPatch` for
/// the whole worktree — the web Changes view splits that patch per file rather
/// than asking the server for each one, and so does this. Nothing here talks
/// to the network: it is a parser, so it can be tested as one.
struct FilePatch: Hashable, Identifiable, Sendable {
    /// The file as it exists after the change (a rename reports its new name).
    let path: String
    /// The `diff --git` section verbatim, headers included.
    let patch: String

    var id: String { path }
}

enum PatchSplitter {
    /// Split a multi-file unified patch into its per-file sections.
    ///
    /// Sections are delimited by `diff --git`, which is also the only thing
    /// present for a binary file or a bare mode change — those have no
    /// `---`/`+++` pair and no hunks, and they still get an entry, because a
    /// file that changed should be listed even when there is nothing to read.
    static func split(_ rawPatch: String) -> [FilePatch] {
        guard !rawPatch.isEmpty else { return [] }
        var patches: [FilePatch] = []
        var current: [String] = []

        func flush() {
            guard !current.isEmpty, let path = path(in: current) else {
                current = []
                return
            }
            patches.append(
                FilePatch(path: path, patch: current.joined(separator: "\n"))
            )
            current = []
        }

        for line in rawPatch.split(
            separator: "\n",
            omittingEmptySubsequences: false
        ) {
            if line.hasPrefix("diff --git ") { flush() }
            current.append(String(line))
        }
        flush()
        return patches
    }

    /// The patch for one file of the list, or nil when the section is absent
    /// (a truncated patch) or the file is binary.
    static func patch(for path: String, in patches: [FilePatch]) -> String? {
        patches.first { $0.path == path }?.patch
    }

    /// Name the section's file.
    ///
    /// The `+++`/`---` headers are preferred over the `diff --git` line
    /// because each carries exactly ONE path: `diff --git a/my file b/my file`
    /// cannot be split on " b/" without guessing, and a name containing " b/"
    /// defeats the guess entirely. The header line is only the fallback for
    /// the sections that have no pair at all.
    private static func path(in lines: [String]) -> String? {
        // A hunk marker ends the header block; anything after it is content
        // that can legitimately start with "+++" or "---".
        let headers = lines.prefix { !$0.hasPrefix("@@ ") }
        for prefix in ["+++ ", "--- "] {
            for line in headers where line.hasPrefix(prefix) {
                if let path = target(line.dropFirst(prefix.count)) { return path }
            }
        }
        guard let header = lines.first,
              header.hasPrefix("diff --git "),
              let separator = header.range(of: " b/")
        else { return nil }
        return String(header[separator.upperBound...])
    }

    /// Strip what git decorates a header path with: the `a/`/`b/` prefix, and
    /// a trailing tab plus timestamp (which is how a name with trailing
    /// whitespace stays unambiguous). `/dev/null` is the other side of an
    /// add or a delete, and names no file.
    private static func target(_ value: Substring) -> String? {
        var text = String(value)
        if let tab = text.firstIndex(of: "\t") { text = String(text[..<tab]) }
        guard text != "/dev/null" else { return nil }
        if text.hasPrefix("a/") || text.hasPrefix("b/") { text.removeFirst(2) }
        return text.isEmpty ? nil : text
    }
}
