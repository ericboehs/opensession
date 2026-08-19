import XCTest
@testable import OS1

/// The server sends facts and leaves the wording to the client, so these
/// rules are the whole difference between an integration reading as on, as
/// half-configured, or as off — on both the Integrations page and the Setup
/// checklist, which now share them.
final class IntegrationRulesTests: XCTestCase {
    private func integration(
        id: String = "slack",
        enabled: Bool? = nil,
        missing: [String]? = nil
    ) -> IntegrationSettings {
        IntegrationSettings(id: id, enabled: enabled, missingRequired: missing)
    }

    // MARK: - What a row says

    func testAnEnabledIntegrationWithEveryCredentialIsOn() {
        let state = IntegrationRules.state(integration(enabled: true, missing: []))
        XCTAssertEqual(state.tone, .on)
        XCTAssertEqual(state.label, "On")
    }

    /// Enabled but incomplete is the state worth catching: it looks configured
    /// and does nothing.
    func testAnEnabledIntegrationMissingCredentialsWarns() {
        let state = IntegrationRules.state(integration(enabled: true, missing: ["SLACK_BOT_TOKEN"]))
        XCTAssertEqual(state.tone, .warn)
        XCTAssertEqual(state.label, "Missing credentials")
    }

    func testADisabledIntegrationIsOffHoweverCompleteItIs() {
        XCTAssertEqual(IntegrationRules.state(integration(enabled: false, missing: [])).tone, .off)
        XCTAssertEqual(IntegrationRules.state(integration()).tone, .off)
    }

    // MARK: - Whether the switch is offered

    func testSomethingAlreadyOnCanAlwaysBeTurnedOff() {
        XCTAssertTrue(IntegrationRules.canToggle(integration(enabled: true, missing: ["SLACK_BOT_TOKEN"])))
    }

    func testSomethingOffWithoutItsCredentialsCannotBeTurnedOn() {
        XCTAssertFalse(IntegrationRules.canToggle(integration(enabled: false, missing: ["SLACK_BOT_TOKEN"])))
    }

    func testSomethingOffWithEveryCredentialCanBeTurnedOn() {
        XCTAssertTrue(IntegrationRules.canToggle(integration(enabled: false, missing: [])))
    }

    /// Code storage is switched by connecting a host, not by a flag, so it
    /// never offers one however complete it looks.
    func testCodeStorageNeverOffersASwitch() {
        XCTAssertFalse(IntegrationRules.canToggle(integration(id: "codestorage", enabled: true, missing: [])))
    }

    // MARK: - GitHub sign-in

    func testGithubSignInNeedsBothTheFlagAndTheApp() {
        // A client secret is not part of being active: sign-in is a device
        // code either way, and the secret only decides whether the token that
        // sign-in returns can be renewed.
        let active = GithubSignInSettings(
            userPrAuth: true,
            clientIdConfigured: true,
            clientSecretConfigured: true
        )
        XCTAssertEqual(IntegrationRules.githubState(active).label, "Active")

        let noSecret = GithubSignInSettings(
            userPrAuth: true,
            clientIdConfigured: true,
            clientSecretConfigured: false
        )
        XCTAssertEqual(IntegrationRules.githubState(noSecret).label, "Active")

        let noApp = GithubSignInSettings(userPrAuth: true, clientIdConfigured: false)
        XCTAssertEqual(IntegrationRules.githubState(noApp).tone, .warn)
        XCTAssertEqual(IntegrationRules.githubState(noApp).label, "Missing client id")

        XCTAssertEqual(IntegrationRules.githubState(GithubSignInSettings()).tone, .off)
    }

    func testTheGithubSentenceSaysWhatIsTrueOfEachState() {
        XCTAssertTrue(
            IntegrationRules.githubDetail(GithubSignInSettings()).contains("workspace account")
        )
        XCTAssertTrue(
            IntegrationRules.githubDetail(
                GithubSignInSettings(userPrAuth: true, clientIdConfigured: true, clientSecretConfigured: false)
            ).contains("client secret")
        )
        XCTAssertTrue(
            IntegrationRules.githubDetail(
                GithubSignInSettings(userPrAuth: true, clientIdConfigured: true, clientSecretConfigured: true)
            ).contains("as themselves")
        )
    }

    // MARK: - Decoding

    /// `description` is spoken for on every Swift type, so the wire name is
    /// mapped. A silent mismatch would leave every credential unexplained.
    func testAnEnvVarKeepsItsDescription() throws {
        let variable = try JSONDecoder().decode(
            IntegrationEnvVar.self,
            from: Data(#"{"name":"SLACK_BOT_TOKEN","required":true,"description":"Bot token","present":false}"#.utf8)
        )
        XCTAssertEqual(variable.name, "SLACK_BOT_TOKEN")
        XCTAssertEqual(variable.detail, "Bot token")
        XCTAssertEqual(variable.required, true)
        XCTAssertEqual(variable.present, false)
    }

    /// Every field but the id is optional, so a server that grows or drops
    /// one cannot break an older build.
    func testAnIntegrationDecodesFromAPayloadCarryingOnlyAnId() throws {
        let decoded = try JSONDecoder().decode(
            IntegrationSettings.self,
            from: Data(#"{"id":"plain"}"#.utf8)
        )
        XCTAssertEqual(decoded.id, "plain")
        XCTAssertEqual(decoded.title, "plain")
        XCTAssertNil(decoded.enabled)
    }

    func testEveryDescribedIntegrationReadsAsWhatItBrings() {
        XCTAssertEqual(
            IntegrationRules.description(integration(id: "linear")),
            "Assigned issues become scoped coding sessions."
        )
        // An id the registry grows before this build knows about it still
        // gets a sentence rather than an empty line.
        XCTAssertEqual(
            IntegrationRules.description(IntegrationSettings(id: "notion", label: "Notion")),
            "Connect Notion."
        )
    }
}
