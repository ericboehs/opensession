import Foundation

/// Which key runs which busy-send action, for the Mac composer's send menu.
/// Mirrors `busySendKeys` in src/frontend/components/Composer.tsx, against the
/// keys this app's own composer monitor actually binds.
///
/// The two clients read one pair of preferences the same way and bind them
/// differently in one case, so this is not a copy of the web helper:
///
/// - `busy-send` is what the send button does. On the Mac, plain Return is the
///   send button, so it carries that preference only while Return is the send
///   key. With Command+Return as the send key, Return inserts a newline and no
///   key carries `busy-send` at all.
/// - `busy-send-mod` is what Command/Control+Return does, always. The web
///   collapses that row when Command+Return is itself the send key; the Mac
///   composer keeps the modifier on its own preference either way, so the row
///   keeps its key.
///
/// iPhone and iPad have no modifier to name, so nothing here reaches them.
enum BusySendHints {
    static let returnGlyph = "\u{21A9}"
    static let modReturnGlyph = "\u{2318}\u{21A9}"

    /// The keys that run `pref` ("steer" or "queue") right now, or nil when
    /// none does. Both keys land on one row when the two preferences agree.
    static func keys(
        for pref: String,
        busySend: String,
        busySendMod: String,
        sendKey: String
    ) -> String? {
        var glyphs: [String] = []
        if sendKey == "enter", busySend == pref { glyphs.append(returnGlyph) }
        if busySendMod == pref { glyphs.append(modReturnGlyph) }
        return glyphs.isEmpty ? nil : glyphs.joined(separator: " ")
    }
}
