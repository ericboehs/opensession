import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
#if canImport(AppKit)
import AppKit
#endif

/// One vocabulary for every haptic in the app, and one switch that turns them
/// all off.
///
/// Cues are named for what HAPPENED, not for the waveform they play. The same
/// act should feel the same wherever it appears — sending from the composer,
/// from a catch-up card, from a support thread — and a call site that asks for
/// `.send` keeps doing the right thing when that tap is retuned. Reaching for
/// `UIImpactFeedbackGenerator` at a call site instead is how an app ends up
/// with five slightly different taps for one gesture, and how a haptic escapes
/// the setting below.
///
/// Two ways to play one: `.haptic(_:trigger:)` on a view for anything driven by
/// state (a counter that ticks per send, a phase that reaches `.sent`), and
/// `Haptics.play(_:)` inside an action for the cases where the view is about to
/// go away — a sheet that dismisses in the same turn never gets to observe its
/// own trigger change.
enum Haptics {
    /// Device-local, like the theme: a Taptic Engine belongs to the phone in
    /// your hand, not to the account, and the Mac in the same account has none.
    /// Absent means on — the default is the premium one, and `object(forKey:)`
    /// is what tells "never set" apart from a deliberate off.
    static let preferenceKey = "os1.haptics"

    static var isEnabled: Bool {
        UserDefaults.standard.object(forKey: preferenceKey) as? Bool ?? true
    }

    /// What just happened, in the app's own terms.
    enum Cue: Equatable {
        /// A message left for the server: the composer, an answer, a reply.
        case send
        /// Something exists now that didn't: a session started, a question
        /// answered, a review submitted, a deck cleared.
        case commit
        /// A run stopped on purpose.
        case stop
        /// A choice moved under the finger — a queued message changing places.
        case selection
        /// Something went live and stays live until you end it: dictation
        /// listening, a card armed under a drag.
        case armed
        /// …and the release of it. Deliberately lighter than `.armed`, so the
        /// pair reads as one gesture opening and closing rather than two taps.
        case released
        /// The app couldn't do what was asked.
        case warn
    }

    /// Warm the Taptic Engine so the next cue lands with the tap that caused
    /// it rather than a beat later. Cheap and idempotent; call it when a send
    /// becomes plausible (the composer gaining text), not on every keystroke.
    @MainActor
    static func prepare() {
        guard isEnabled else { return }
        #if os(iOS)
        impactGenerator(for: .medium).prepare()
        notificationGenerator.prepare()
        #endif
    }

    @MainActor
    static func play(_ cue: Cue) {
        guard isEnabled else { return }
        #if os(iOS)
        switch cue {
        case .send:
            // Firm enough to confirm the message left the composer, without
            // feeling like the heavier stop action beside it.
            impact(.medium, intensity: 0.9)
        case .commit:
            notificationGenerator.notificationOccurred(.success)
            notificationGenerator.prepare()
        case .stop:
            impact(.heavy, intensity: 0.6)
        case .selection:
            selectionGenerator.selectionChanged()
            selectionGenerator.prepare()
        case .armed:
            impact(.medium, intensity: 0.85)
        case .released:
            impact(.light, intensity: 0.45)
        case .warn:
            notificationGenerator.notificationOccurred(.warning)
            notificationGenerator.prepare()
        }
        #elseif os(macOS)
        // Force Touch trackpads only, and only when the person has left
        // trackpad feedback on — the performer no-ops everywhere else, which
        // is why this needs no capability check of its own.
        let pattern: NSHapticFeedbackManager.FeedbackPattern
        switch cue {
        case .selection, .armed, .released: pattern = .alignment
        case .send, .commit, .stop, .warn: pattern = .generic
        }
        NSHapticFeedbackManager.defaultPerformer.perform(pattern, performanceTime: .now)
        #endif
    }

    #if os(iOS)
    /// Generators are kept rather than made per tap: a fresh one has to spin
    /// the engine up before it can play, which is exactly the latency that
    /// makes a haptic feel bolted on. Re-preparing after each play keeps the
    /// engine warm for the next one in a burst.
    @MainActor private static var impactGenerators:
        [UIImpactFeedbackGenerator.FeedbackStyle: UIImpactFeedbackGenerator] = [:]
    @MainActor private static let notificationGenerator = UINotificationFeedbackGenerator()
    @MainActor private static let selectionGenerator = UISelectionFeedbackGenerator()

    @MainActor
    private static func impactGenerator(
        for style: UIImpactFeedbackGenerator.FeedbackStyle
    ) -> UIImpactFeedbackGenerator {
        if let existing = impactGenerators[style] { return existing }
        let generator = UIImpactFeedbackGenerator(style: style)
        impactGenerators[style] = generator
        return generator
    }

    @MainActor
    private static func impact(
        _ style: UIImpactFeedbackGenerator.FeedbackStyle,
        intensity: CGFloat
    ) {
        let generator = impactGenerator(for: style)
        generator.impactOccurred(intensity: intensity)
        generator.prepare()
    }
    #endif
}

extension Haptics.Cue {
    /// The SwiftUI spelling of the same cue, for the view modifier. Kept beside
    /// the UIKit mapping on purpose: the two paths must feel identical, since
    /// which one a call site uses is a question of view lifetime, not of feel.
    var feedback: SensoryFeedback {
        switch self {
        case .send: .impact(weight: .medium, intensity: 0.9)
        case .commit: .success
        case .stop: .impact(weight: .heavy, intensity: 0.6)
        case .selection: .selection
        case .armed: .impact(weight: .medium, intensity: 0.85)
        case .released: .impact(weight: .light, intensity: 0.45)
        case .warn: .warning
        }
    }
}

extension View {
    /// Play `cue` whenever `trigger` changes.
    func haptic<T: Equatable>(_ cue: Haptics.Cue, trigger: T) -> some View {
        modifier(HapticFeedbackModifier(trigger: trigger) { _, _ in cue })
    }

    /// Play the cue the closure picks for a given transition — `nil` for the
    /// changes that shouldn't be felt, which is most of them.
    func haptic<T: Equatable>(
        trigger: T,
        _ cue: @escaping (T, T) -> Haptics.Cue?
    ) -> some View {
        modifier(HapticFeedbackModifier(trigger: trigger, cue: cue))
    }
}

/// The setting is read here, once, rather than at every call site — a haptic
/// that forgets to check it is a haptic the switch doesn't turn off. `AppStorage`
/// (not `Haptics.isEnabled`) so flipping the toggle takes effect on screens
/// that are already on screen.
private struct HapticFeedbackModifier<T: Equatable>: ViewModifier {
    @AppStorage(Haptics.preferenceKey) private var enabled = true

    let trigger: T
    let cue: (T, T) -> Haptics.Cue?

    func body(content: Content) -> some View {
        content.sensoryFeedback(trigger: trigger) { old, new in
            guard enabled else { return nil }
            return cue(old, new)?.feedback
        }
    }
}
