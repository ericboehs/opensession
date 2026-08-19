import SwiftUI

/// The screen a refused session gets, and the only thing on it is the way out.
///
/// It is an overlay rather than a sheet on purpose: a sheet can be swiped away,
/// and everything behind this one is already answering 401. Nothing here is
/// dismissible except by signing in, which is the point. The device flow lives
/// in `GitHubSignIn.shared`, outside any view lifecycle, so entering the code
/// over in Safari (and the app being suspended while you do) does not lose it.
struct ReconnectCover: View {
    let reason: AuthGate.Reason

    @Environment(\.openURL) private var openURL
    @State private var signIn = GitHubSignIn.shared
    @State private var copiedCode = false

    private var title: String {
        switch reason {
        case .reconnect: "Reconnect GitHub"
        case .signedOut: "Sign in again"
        }
    }

    private var message: String {
        switch reason {
        case .reconnect(let login):
            let who = login.map { "@\($0)" } ?? "this device"
            return "GitHub's authorization for \(who) expired. Sign in again to continue."
        case .signedOut:
            return "This device's session is no longer valid. Sign in again to continue."
        }
    }

    var body: some View {
        ZStack {
            OS1VisualStyle.background.ignoresSafeArea()
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                Image(systemName: "person.badge.key")
                    .font(.system(size: 34))
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .padding(.bottom, 18)
                Text(title)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.text)
                Text(message)
                    .font(.callout)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .multilineTextAlignment(.center)
                    .padding(.top, 8)
                    .padding(.horizontal, 8)
                if let flow = signIn.flow {
                    code(flow)
                } else {
                    Button {
                        signIn.error = nil
                        signIn.start()
                    } label: {
                        Text(signIn.starting ? "Starting…" : "Continue with GitHub")
                            .font(.body.weight(.medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(signIn.starting)
                    .padding(.top, 24)
                }
                if let error = signIn.error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.top, 14)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: 420)
            .padding(.horizontal, 32)
        }
        // Foregrounding after approving the code on GitHub is the usual way
        // this ends, and the poll may have died with the process.
        .onAppear { signIn.nudge() }
    }

    /// The same well the Settings sign-in uses, so the two are one screen in
    /// two places rather than two designs for one code.
    @ViewBuilder
    private func code(_ flow: GitHubAuth.DeviceFlowStart) -> some View {
        VStack(spacing: 10) {
            Text("Enter this code at \(flow.verificationUri.replacingOccurrences(of: "https://", with: ""))")
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textDim)
                .multilineTextAlignment(.center)
            Button {
                copyToPasteboard(flow.userCode)
                copiedCode = true
            } label: {
                Text(flow.userCode)
                    .font(.system(.title, design: .monospaced).bold())
                    .foregroundStyle(OS1VisualStyle.text)
                    .kerning(2)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(OS1VisualStyle.markdownInlineCode)
                    )
            }
            .buttonStyle(.plain)
            Text(copiedCode ? "Copied. Paste it on GitHub." : "Tap the code to copy it.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
            if let url = URL(string: flow.verificationUri) {
                Button {
                    copyToPasteboard(flow.userCode)
                    copiedCode = true
                    openURL(url)
                } label: {
                    Text("Copy code and open GitHub")
                        .font(.body.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
                .padding(.top, 4)
            }
            HStack(spacing: 8) {
                ProgressView()
                Text("Waiting for approval…")
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
                Spacer()
                Button("Cancel", role: .cancel) { signIn.cancel() }
                    .font(.footnote)
            }
            .padding(.top, 4)
        }
        .padding(.top, 24)
    }
}
