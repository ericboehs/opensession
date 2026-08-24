import XCTest
@testable import OS1

final class PortalServiceTests: XCTestCase {
    private func decode(_ json: String) throws -> PortalStatus {
        try JSONDecoder().decode(PortalStatus.self, from: Data(json.utf8))
    }

    func testDecodesTheHostPreviewShape() throws {
        let status = try decode("""
        {"hasPortsConf":true,"webappPort":3000,"running":true,"starting":false,
         "previewUrl":"https://host:8443","bootable":true,"portalRecipes":[],
         "services":[{"name":"Webapp","key":"WEBAPP_PORT","port":3000,
                      "running":true,"pids":[42],
                      "previewUrl":"https://host:8443"}]}
        """)
        XCTAssertEqual(status.services.count, 1)
        XCTAssertEqual(status.liveCount, 1)
        let service = try XCTUnwrap(status.services.first)
        XCTAssertEqual(service.name, "Webapp")
        XCTAssertEqual(service.port, 3000)
        XCTAssertEqual(service.display, .live)
        XCTAssertEqual(service.openURL?.absoluteString, "https://host:8443")
    }

    /// A field this build has never seen must not blank the row, and neither
    /// must a lifecycle value the server grew after this build shipped.
    func testUnknownStateAndUnknownFieldsSurvive() throws {
        let status = try decode("""
        {"services":[{"name":"Docs","key":"DOCS_PORT","port":4000,
                      "running":true,"pids":[],"state":"hibernating",
                      "somethingNew":{"a":1}}]}
        """)
        let service = try XCTUnwrap(status.services.first)
        XCTAssertEqual(service.state, .unknown)
        // Running with no URL to open: honest rather than clickable.
        XCTAssertEqual(service.display, .unavailable)
        XCTAssertNil(service.openURL)
    }

    func testMissingServicesDecodesAsEmpty() throws {
        XCTAssertTrue(try decode("{\"starting\":true}").services.isEmpty)
        XCTAssertTrue(try decode("{\"starting\":true}").starting)
    }

    /// The sleeping-sandbox snapshot: metadata only, deliberately URL-less so
    /// that looking at the list cannot wake compute.
    func testSleepingSandboxPortalIsListedButNotOpenable() throws {
        let status = try decode("""
        {"hasPortsConf":true,"running":false,"starting":false,"previewUrl":null,
         "services":[{"name":"Webapp","key":"WEBAPP_PORT","port":3000,
                      "running":false,"previewUrl":null,"pids":[],
                      "state":"sleeping","managed":true}]}
        """)
        let service = try XCTUnwrap(status.services.first)
        XCTAssertEqual(service.display, .sleeping)
        XCTAssertEqual(service.display.label, "Sleeping")
        XCTAssertNil(service.openURL)
        XCTAssertEqual(status.liveCount, 0)
    }

    func testStoppedAndFailedAreDistinguished() {
        let stopped = PortalService(
            name: "Webapp", key: "WEBAPP_PORT", port: 3000, running: false
        )
        XCTAssertEqual(stopped.display, .stopped)
        let failed = PortalService(
            name: "Webapp", key: "WEBAPP_PORT", port: 3000, running: false,
            state: .failed
        )
        XCTAssertEqual(failed.display, .failed)
        let starting = PortalService(
            name: "Webapp", key: "WEBAPP_PORT", port: 3000, running: false,
            state: .starting
        )
        XCTAssertEqual(starting.display, .starting)
    }

    /// `defaultPath` lands people where the app actually begins, the same way
    /// the web's `portalTargetFor` resolves it, with or without its slash.
    func testDefaultPathIsResolvedAgainstThePortalRoot() {
        let rooted = PortalService(
            name: "Docs", key: "DOCS_PORT", port: 4000, running: true,
            previewUrl: "https://host:8443", defaultPath: "/docs/intro"
        )
        XCTAssertEqual(rooted.openURL?.absoluteString, "https://host:8443/docs/intro")

        let bare = PortalService(
            name: "Docs", key: "DOCS_PORT", port: 4000, running: true,
            previewUrl: "https://host:8443", defaultPath: "docs/intro"
        )
        XCTAssertEqual(bare.openURL?.absoluteString, "https://host:8443/docs/intro")
    }

    /// Only the supervisor's own portals can be stopped or restarted. A plain
    /// process the session started for itself has no lifecycle to offer.
    func testOnlyManagedServicesOfferControls() throws {
        let status = try decode("""
        {"services":[{"name":"webapp","key":"WEBAPP_PORT","port":3000,
                      "running":true,"pids":[7],"managed":true,
                      "previewUrl":"https://host:8443"},
                     {"name":"Stray","key":"OTHER_PORT","port":9000,
                      "running":true,"pids":[8]}]}
        """)
        let managed = try XCTUnwrap(status.services.first)
        XCTAssertTrue(managed.managed)
        XCTAssertTrue(managed.canStop)
        XCTAssertTrue(managed.canRestart)

        let unmanaged = try XCTUnwrap(status.services.last)
        XCTAssertFalse(unmanaged.managed)
        XCTAssertFalse(unmanaged.canStop)
        XCTAssertFalse(unmanaged.canRestart)
    }

    /// Stopping is never offered on a sleeping Sandbox — the server answers
    /// 409 rather than waking compute to end a process — and restarting one
    /// asks first, because it wakes the Sandbox.
    func testSleepingPortalRestartsWithAWarningAndNeverStops() {
        let sleeping = PortalService(
            name: "webapp", key: "WEBAPP_PORT", port: 3000, running: false,
            state: .sleeping, managed: true
        )
        XCTAssertFalse(sleeping.canStop)
        XCTAssertTrue(sleeping.canRestart)
        XCTAssertTrue(sleeping.needsConfirmation(for: .restart))

        let live = PortalService(
            name: "webapp", key: "WEBAPP_PORT", port: 3000, running: true,
            previewUrl: "https://host:8443", managed: true
        )
        // The one-tap fix this screen exists for: no dialog in front of it.
        XCTAssertFalse(live.needsConfirmation(for: .restart))
        XCTAssertTrue(live.needsConfirmation(for: .stop))
    }

    /// The words sent to the session are the web's words, so a conversation
    /// reads the same however the request was made.
    func testRecipePromptMatchesTheWebRequest() throws {
        let status = try decode("""
        {"services":[],"portalRecipes":[
            {"name":"Docs site","description":"MkDocs on 8000",
             "skill":"start-docs","serviceKey":"DOCS_PORT"},
            {"name":"Storybook","skill":"start-storybook"}]}
        """)
        XCTAssertEqual(status.recipes.count, 2)
        let keyed = try XCTUnwrap(status.recipes.first)
        XCTAssertEqual(keyed.subtitle, "MkDocs on 8000")
        XCTAssertEqual(
            keyed.startPrompt,
            "Use the $start-docs skill to start the “Docs site” portal for this "
                + "session. Make sure it listens on the DOCS_PORT port declared "
                + "in .ports.conf, then report when it is ready."
        )

        let bare = try XCTUnwrap(status.recipes.last)
        XCTAssertEqual(bare.subtitle, "Starts with the start-storybook skill.")
        XCTAssertEqual(
            bare.startPrompt,
            "Use the $start-storybook skill to start the “Storybook” portal for "
                + "this session. Expose its listening port in .ports.conf with a "
                + "descriptive *_PORT key, then report when it is ready."
        )
    }

    /// A starter whose service is already live is not offered: that service is
    /// a row you can tap, and two ways to say the same thing is one too many.
    func testLiveServiceSuppressesItsStarter() throws {
        let live = try decode("""
        {"services":[{"name":"docs","key":"DOCS_PORT","port":8000,"running":true,
                      "pids":[3],"previewUrl":"https://host:8443"}],
         "portalRecipes":[{"name":"Docs site","skill":"start-docs",
                           "serviceKey":"DOCS_PORT"}]}
        """)
        XCTAssertTrue(live.startableRecipes.isEmpty)

        let stopped = try decode("""
        {"services":[{"name":"docs","key":"DOCS_PORT","port":8000,
                      "running":false,"pids":[],"state":"stopped"}],
         "portalRecipes":[{"name":"Docs site","skill":"start-docs",
                           "serviceKey":"DOCS_PORT"}]}
        """)
        XCTAssertEqual(stopped.startableRecipes.count, 1)
    }

    /// The sleeping snapshot carries no starters, so nothing on the screen can
    /// offer to wake a Sandbox by the back door.
    func testSleepingSandboxOffersNoStarters() throws {
        let status = try decode("""
        {"hasPortsConf":true,"running":false,"starting":false,"previewUrl":null,
         "portalRecipes":[],
         "services":[{"name":"webapp","key":"WEBAPP_PORT","port":3000,
                      "running":false,"previewUrl":null,"pids":[],
                      "state":"sleeping","managed":true}]}
        """)
        XCTAssertTrue(status.startableRecipes.isEmpty)
    }

    /// A server that predates the field, and one that answers no starters at
    /// all, must both decode rather than blanking the list.
    func testMissingRecipesDecodeAsEmpty() throws {
        XCTAssertTrue(try decode("{\"starting\":false}").recipes.isEmpty)
        XCTAssertFalse(try decode("{\"starting\":false}").services.contains { $0.managed })
    }

    func testNotRunningNeverProducesAURL() {
        let service = PortalService(
            name: "Webapp", key: "WEBAPP_PORT", port: 3000, running: false,
            previewUrl: "https://host:8443", state: .stopped
        )
        XCTAssertNil(service.openURL)
    }
}
