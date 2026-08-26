import XCTest
@testable import OS1

/// The Changes view reads one whole-worktree patch and shows a file at a time,
/// so every file it can show depends on this split being right. The cases that
/// bite are the ones with no `+++`/`---` pair (binary, mode-only) and the ones
/// whose names defeat the `diff --git` line.
final class FilePatchTests: XCTestCase {
    func testSplitsSectionsPerFile() {
        let raw = """
        diff --git a/one.swift b/one.swift
        index 111..222 100644
        --- a/one.swift
        +++ b/one.swift
        @@ -1,2 +1,2 @@
        -let a = 1
        +let a = 2
        diff --git a/two.swift b/two.swift
        index 333..444 100644
        --- a/two.swift
        +++ b/two.swift
        @@ -5,1 +5,2 @@
         let b = 3
        +let c = 4
        """
        let patches = PatchSplitter.split(raw)
        XCTAssertEqual(patches.map(\.path), ["one.swift", "two.swift"])
        XCTAssertTrue(patches[0].patch.hasPrefix("diff --git a/one.swift"))
        XCTAssertTrue(patches[0].patch.hasSuffix("+let a = 2"))
        XCTAssertTrue(patches[1].patch.contains("+let c = 4"))
        // The second section must not swallow the first one's trailing lines.
        XCTAssertFalse(patches[1].patch.contains("let a = 2"))
    }

    func testAddedFileTakesTheNewPath() {
        let raw = """
        diff --git a/new.txt b/new.txt
        new file mode 100644
        index 000..111
        --- /dev/null
        +++ b/new.txt
        @@ -0,0 +1 @@
        +hello
        """
        XCTAssertEqual(PatchSplitter.split(raw).map(\.path), ["new.txt"])
    }

    func testDeletedFileFallsBackToTheOldPath() {
        let raw = """
        diff --git a/gone.txt b/gone.txt
        deleted file mode 100644
        index 111..000
        --- a/gone.txt
        +++ /dev/null
        @@ -1 +0,0 @@
        -hello
        """
        XCTAssertEqual(PatchSplitter.split(raw).map(\.path), ["gone.txt"])
    }

    func testRenameReportsTheNewName() {
        let raw = """
        diff --git a/old/name.swift b/new/name.swift
        similarity index 96%
        rename from old/name.swift
        rename to new/name.swift
        --- a/old/name.swift
        +++ b/new/name.swift
        @@ -1 +1 @@
        -x
        +y
        """
        XCTAssertEqual(PatchSplitter.split(raw).map(\.path), ["new/name.swift"])
    }

    /// No `---`/`+++` pair at all — the header line is the only name there is.
    func testBinaryFileStillGetsAnEntry() {
        let raw = """
        diff --git a/shot.png b/shot.png
        index 111..222 100644
        Binary files a/shot.png and b/shot.png differ
        """
        let patches = PatchSplitter.split(raw)
        XCTAssertEqual(patches.map(\.path), ["shot.png"])
        XCTAssertTrue(patches[0].patch.contains("Binary files"))
    }

    /// A name with spaces makes `diff --git a/x b/x` ambiguous, which is
    /// exactly why the header pair is preferred over it.
    func testPathWithSpaces() {
        let raw = """
        diff --git a/my notes b/my notes
        index 111..222 100644
        --- a/my notes\t
        +++ b/my notes\t
        @@ -1 +1 @@
        -x
        +y
        """
        XCTAssertEqual(PatchSplitter.split(raw).map(\.path), ["my notes"])
    }

    /// Content lines can start with "+++"/"---" — a Markdown rule, a diff
    /// pasted into a file — and must not be read as headers of the next file.
    func testContentThatLooksLikeAHeaderIsNotAPath() {
        let raw = """
        diff --git a/doc.md b/doc.md
        index 111..222 100644
        --- a/doc.md
        +++ b/doc.md
        @@ -1,2 +1,3 @@
         intro
        ++++ b/decoy.md
        """
        XCTAssertEqual(PatchSplitter.split(raw).map(\.path), ["doc.md"])
    }

    func testEmptyPatchIsNoFiles() {
        XCTAssertTrue(PatchSplitter.split("").isEmpty)
    }

    func testLookupByPath() {
        let patches = [
            FilePatch(path: "a.swift", patch: "diff --git a/a.swift b/a.swift"),
        ]
        XCTAssertNotNil(PatchSplitter.patch(for: "a.swift", in: patches))
        XCTAssertNil(PatchSplitter.patch(for: "b.swift", in: patches))
    }
}
