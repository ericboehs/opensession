import XCTest
@testable import OS1

final class ToolCallDetailTests: XCTestCase {
    private func item() -> ToolCallItem {
        ToolCallItem(
            id: "call-1",
            use: nil,
            result: TranscriptEntry(
                id: "result-1",
                type: "tool_result",
                content: "preview",
                toolUseId: "call-1",
                contentClamped: true,
                contentLength: 4_000
            ),
            isLive: false,
            presentation: ToolPresentation(
                canonical: "Bash",
                mcpServer: nil,
                name: "Bash",
                family: .run,
                summary: "",
                summaryIsPath: false,
                lineStats: nil,
                touchedFiles: []
            )
        )
    }

    func testHydratedResultReplacesThePreviewAndDropsItsTruncatedLabel() {
        let preview = ToolDetail.make(item: item())
        XCTAssertEqual(preview.resultLabel, "Output (truncated)")
        XCTAssertEqual(preview.resultText, "preview")

        let hydrated = ToolDetail.make(
            item: item(),
            hydratedResultText: "complete result"
        )
        XCTAssertEqual(hydrated.resultLabel, "Output")
        XCTAssertEqual(hydrated.resultText, "complete result")
    }
}
