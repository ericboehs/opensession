import XCTest
@testable import OS1

final class BusySendHintsTests: XCTestCase {
    private func keys(
        _ pref: String,
        busySend: String = "queue",
        busySendMod: String = "steer",
        sendKey: String = "enter"
    ) -> String? {
        BusySendHints.keys(
            for: pref,
            busySend: busySend,
            busySendMod: busySendMod,
            sendKey: sendKey
        )
    }

    /// The shipping default: Return queues, Command+Return steers.
    func testDefaultsPutOneKeyOnEachRow() {
        XCTAssertEqual(keys("queue"), BusySendHints.returnGlyph)
        XCTAssertEqual(keys("steer"), BusySendHints.modReturnGlyph)
    }

    func testAgreeingPreferencesPutBothKeysOnOneRow() {
        XCTAssertEqual(
            keys("steer", busySend: "steer", busySendMod: "steer"),
            "\(BusySendHints.returnGlyph) \(BusySendHints.modReturnGlyph)"
        )
        XCTAssertNil(keys("queue", busySend: "steer", busySendMod: "steer"))
    }

    /// With Command+Return as the send key, plain Return inserts a newline, so
    /// no key runs the send button's preference and that row shows none.
    func testModReturnSendKeyLeavesTheSendPreferenceUnbound() {
        XCTAssertNil(keys("queue", sendKey: "mod-enter"))
        XCTAssertEqual(keys("steer", sendKey: "mod-enter"), BusySendHints.modReturnGlyph)
    }

    /// The modifier keeps its own preference whatever the send key is, which
    /// is where this differs from the web helper.
    func testModifierKeepsItsPreferenceUnderEitherSendKey() {
        for sendKey in ["enter", "mod-enter"] {
            XCTAssertEqual(
                keys("queue", busySendMod: "queue", sendKey: sendKey),
                sendKey == "enter"
                    ? "\(BusySendHints.returnGlyph) \(BusySendHints.modReturnGlyph)"
                    : BusySendHints.modReturnGlyph
            )
        }
    }

    func testUnknownPreferenceValueGetsNoKeys() {
        XCTAssertNil(keys("shout"))
    }
}
