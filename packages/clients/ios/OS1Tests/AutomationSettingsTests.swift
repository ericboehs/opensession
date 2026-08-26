import Foundation
import XCTest
@testable import OS1

final class AutomationSettingsTests: XCTestCase {
    func testAutomationDecodesOwnerAndWorkspaceAssignment() throws {
        let automation = try JSONDecoder().decode(
            Automation.self,
            from: Data(#"{"id":"auto-1","owner":"Kent","workspaceId":"ws-native"}"#.utf8)
        )

        XCTAssertEqual(automation.owner, "Kent")
        XCTAssertEqual(automation.workspaceId, "ws-native")
    }

    func testOlderAutomationPayloadStillDecodesWithoutAssignments() throws {
        let automation = try JSONDecoder().decode(
            Automation.self,
            from: Data(#"{"id":"auto-1","name":"Daily review"}"#.utf8)
        )

        XCTAssertNil(automation.owner)
        XCTAssertNil(automation.workspaceId)
    }

    func testEditPatchAssignsOnlyFieldsOwnedByTheForm() {
        let patch = automationFormBody(
            isEditing: true,
            name: "Daily review",
            prompt: "Review open pull requests.",
            schedule: "0 9 * * 1-5",
            mode: "code",
            model: "gpt-5.6-sol",
            owner: "  Kent  ",
            workspaceId: "ws-reviews",
            mcpAccess: "selected",
            mcpServers: "github, linear",
            createdBy: "Automation"
        )

        XCTAssertEqual(patch["owner"] as? String, "Kent")
        XCTAssertEqual(patch["workspaceId"] as? String, "ws-reviews")
        XCTAssertEqual(patch["mcpServers"] as? [String], ["github", "linear"])
        XCTAssertNil(patch["createdBy"])
        for field in ["enabled", "repo", "prReviewer", "fallbackModel", "inputs", "outputs"] {
            XCTAssertNil(patch[field], "Edit patches must not clobber \(field)")
        }
    }

    func testEditPatchUsesEmptyStringsToClearAssignments() {
        let patch = automationFormBody(
            isEditing: true,
            name: "Daily review",
            prompt: "Review open pull requests.",
            schedule: "",
            mode: "ask",
            model: "",
            owner: "   ",
            workspaceId: "",
            mcpAccess: "all",
            mcpServers: "",
            createdBy: "Automation"
        )

        XCTAssertEqual(patch["owner"] as? String, "")
        XCTAssertEqual(patch["workspaceId"] as? String, "")
        XCTAssertTrue(patch["mcpServers"] is NSNull)
    }

    func testCreateBodyOmitsEmptyAssignmentsAndCarriesCreator() {
        let body = automationFormBody(
            isEditing: false,
            name: "Daily review",
            prompt: "Review open pull requests.",
            schedule: "",
            mode: "ask",
            model: "",
            owner: "",
            workspaceId: "",
            mcpAccess: "all",
            mcpServers: "",
            createdBy: "Automation"
        )

        XCTAssertEqual(body["createdBy"] as? String, "Automation")
        XCTAssertNil(body["owner"])
        XCTAssertNil(body["workspaceId"])
        XCTAssertNil(body["mcpServers"])
    }
}
