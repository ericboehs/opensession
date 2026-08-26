import XCTest
@testable import OS1

/// An edit to the roster sends only what changed, and the difference between
/// "left alone" and "emptied" is a key that is absent versus a key that is
/// null. Both look identical on screen — the field is blank either way — so
/// the rule is tested rather than eyeballed.
final class TeamMemberBodyTests: XCTestCase {
    private let ada = TeamMemberSettings(
        name: "Ada",
        email: "ada@example.com",
        github: "adalovelace",
        slackId: "U01ABCDEF",
        aliases: ["ada"]
    )

    // MARK: - Adding

    func testAddSendsOnlyTheFieldsThatWereFilledIn() {
        var draft = TeamMemberDraft()
        draft.name = "  Grace  "
        draft.github = "gracehopper"
        let body = TeamMemberBody.add(draft)
        XCTAssertEqual(body["name"], .text("Grace"))
        XCTAssertEqual(body["github"], .text("gracehopper"))
        XCTAssertNil(body["email"])
        XCTAssertNil(body["slackId"])
        XCTAssertNil(body["aliases"])
    }

    func testAliasesParseFromOneCommaSeparatedLine() {
        var draft = TeamMemberDraft()
        draft.name = "Grace"
        draft.aliasText = " grace ,, hopper,"
        XCTAssertEqual(TeamMemberBody.add(draft)["aliases"], .aliases(["grace", "hopper"]))
    }

    // MARK: - Editing

    /// An unchanged form is not a request: the server answers a body with
    /// nothing in it with an error, and the caller checks for empty first.
    func testAnUntouchedFormProducesNoPatch() {
        XCTAssertTrue(TeamMemberBody.patch(TeamMemberDraft(ada), from: ada).isEmpty)
    }

    func testOnlyTheChangedFieldRides() {
        var draft = TeamMemberDraft(ada)
        draft.email = "ada@lovelace.dev"
        let patch = TeamMemberBody.patch(draft, from: ada)
        XCTAssertEqual(patch, ["email": .text("ada@lovelace.dev")])
    }

    func testAnEmptiedFieldIsClearedRatherThanOmitted() {
        var draft = TeamMemberDraft(ada)
        draft.slackId = "   "
        XCTAssertEqual(TeamMemberBody.patch(draft, from: ada)["slackId"], .cleared)
    }

    /// A field that was never set and is still blank changed nothing, so it
    /// must not ride as a deletion of something that does not exist.
    func testAFieldThatWasNeverSetStaysOutOfThePatch() {
        let bare = TeamMemberSettings(name: "Grace")
        var draft = TeamMemberDraft(bare)
        draft.github = ""
        XCTAssertTrue(TeamMemberBody.patch(draft, from: bare).isEmpty)
    }

    func testARenameRidesAsTheNameField() {
        var draft = TeamMemberDraft(ada)
        draft.name = "Ada Lovelace"
        XCTAssertEqual(TeamMemberBody.patch(draft, from: ada)["name"], .text("Ada Lovelace"))
    }

    func testEmptyingEveryAliasClearsTheList() {
        var draft = TeamMemberDraft(ada)
        draft.aliasText = " , "
        XCTAssertEqual(TeamMemberBody.patch(draft, from: ada)["aliases"], .cleared)
    }

    // MARK: - The wire

    func testClearedRidesAsNullAndTheRestAsItself() {
        let body: [String: TeamMemberField] = [
            "name": .text("Ada"),
            "aliases": .aliases(["ada"]),
            "slackId": .cleared,
        ]
        let json = body.jsonBody
        XCTAssertEqual(json["name"] as? String, "Ada")
        XCTAssertEqual(json["aliases"] as? [String], ["ada"])
        XCTAssertTrue(json["slackId"] is NSNull)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(json))
    }

    // MARK: - The roster row

    func testTheRowNamesTheIdentifiersAPersonRecognises() {
        XCTAssertEqual(ada.identifierSummary, "ada@example.com · @adalovelace")
        XCTAssertEqual(TeamMemberSettings(name: "Grace").identifierSummary, "")
    }

    /// The roster is keyed case-insensitively by name, and that key is the
    /// path segment every edit is addressed to.
    func testMembersAreIdentifiedByTheirLowercasedName() {
        XCTAssertEqual(TeamMemberSettings(name: "Ada Lovelace").id, "ada lovelace")
    }

    func testAMemberDecodesFromAPayloadCarryingOnlyAName() throws {
        let member = try JSONDecoder().decode(
            TeamMemberSettings.self,
            from: Data(#"{"name":"Grace"}"#.utf8)
        )
        XCTAssertEqual(member.name, "Grace")
        XCTAssertNil(member.github)
    }
}
