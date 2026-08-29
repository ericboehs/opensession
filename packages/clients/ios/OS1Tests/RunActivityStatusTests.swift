import XCTest
@testable import OS1

final class RunActivityStatusTests: XCTestCase {
    func testStartsWithWorkingWithoutElapsedTime() {
        assertStatus(9.999, label: "Working", elapsed: nil)
    }

    func testAcknowledgesWorkAfterTenSeconds() {
        assertStatus(10, label: "Still working", elapsed: "10s")
        assertStatus(44.999, label: "Still working", elapsed: "44s")
    }

    func testElapsedTimeDoesNotCrossUnitBoundariesEarly() {
        XCTAssertEqual(RunActivityStatus.format(59.999), "59s")
        XCTAssertEqual(RunActivityStatus.format(60), "1m")
    }

    func testSetsExpectationsForAnExtendedRun() {
        assertStatus(45, label: "Taking longer than usual", elapsed: "45s")
        assertStatus(90, label: "Taking longer than usual", elapsed: "1m")
    }

    func testFormatsLongRunsCompactlyAndClampsClockSkew() {
        XCTAssertEqual(RunActivityStatus.format(3_900), "1h 5m")
        assertStatus(-1, label: "Working", elapsed: nil)
    }

    private func assertStatus(
        _ seconds: TimeInterval,
        label: String,
        elapsed: String?,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let status = RunActivityStatus(elapsed: seconds)
        XCTAssertEqual(status.label, label, file: file, line: line)
        XCTAssertEqual(status.elapsed, elapsed, file: file, line: line)
    }
}
