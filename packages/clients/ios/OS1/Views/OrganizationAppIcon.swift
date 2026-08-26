import Observation
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// The organization artwork used in app-brand contexts.
@MainActor
@Observable
final class OrganizationBrand {
    static let shared = OrganizationBrand()

    private(set) var settings: OrganizationSettings?
    @ObservationIgnored private var didRequest = false
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var accountID: String?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    private init() {
        settings = SettingsCache.value("organization-settings")
    }

    var iconURL: URL? {
        SettingsAPI.organizationIconURL(settings?.organizationIconUrl)
    }

    /// Apply a settings save immediately, before a launch refresh can answer
    /// with the value it started from.
    func apply(_ next: OrganizationSettings) {
        generation += 1
        set(next)
    }

    func refreshIfNeeded() {
        let currentAccountID = ServerConfig.shared.activeId
        if accountID != currentAccountID {
            refreshTask?.cancel()
            refreshTask = nil
            accountID = currentAccountID
            settings = SettingsCache.value("organization-settings")
            didRequest = false
            generation += 1
        }
        guard !didRequest else { return }
        didRequest = true
        let startedAt = generation
        // Own this task instead of awaiting it from the toolbar view. SwiftUI
        // routinely rebuilds that item during launch and cancels its view task.
        refreshTask = Task { [weak self] in
            guard let self else { return }
            defer { refreshTask = nil }
            guard let next = try? await SettingsAPI.organizationSettings(),
                  generation == startedAt
            else { return }
            set(next)
        }
    }

    private func set(_ next: OrganizationSettings) {
        settings = next
        SettingsCache.save("organization-settings", next)
        if let name = next.organizationName {
            ServerConfig.shared.updateActiveLabel(name)
        }
    }
}

/// The configured organization icon, falling back immediately to the bundled
/// Open Session artwork while it loads, when it is absent, or when it fails.
struct OrganizationAppIcon: View {
    var size: CGFloat = 44
    var fallbackScale: CGFloat = 0.88

    @State private var brand = OrganizationBrand.shared
    @State private var imageCache = RepoImageCache.shared
    @State private var config = ServerConfig.shared

    private var bundledIcon: Image {
        #if os(macOS)
        Image(nsImage: NSApplication.shared.applicationIconImage)
        #else
        // App-icon asset catalogs are not addressable as Image("AppIcon") on
        // iOS. Xcode exports this named primary-icon resource into the bundle.
        if let image = UIImage(named: "AppIcon60x60") {
            Image(uiImage: image)
        } else {
            Image("AppIcon")
        }
        #endif
    }

    var body: some View {
        let iconURL = brand.iconURL
        let organizationIcon = iconURL.flatMap { imageCache.images[$0.absoluteString] }
        let fallbackSize = size * fallbackScale

        ZStack {
            if let organizationIcon {
                organizationIcon
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
            } else {
                bundledIcon
                    .resizable()
                    .scaledToFill()
                    .frame(width: fallbackSize, height: fallbackSize)
                    .clipShape(RoundedRectangle(
                        cornerRadius: fallbackSize * 0.28,
                        style: .continuous
                    ))
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
        .task(id: config.activeId) {
            brand.refreshIfNeeded()
        }
        .task(id: iconURL?.absoluteString) {
            if let iconURL { imageCache.ensureLoaded(iconURL) }
        }
    }
}
