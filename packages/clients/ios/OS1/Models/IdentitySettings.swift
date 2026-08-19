import Foundation

/// Settings → General: what this instance and its agent call themselves.
///
/// Two workspace-wide names from `GET /api/settings/identity`, stored in the
/// server's own config file rather than per device, so everyone on the
/// instance sees the same ones.
///
/// Clearing a field is not the same as storing an empty string: the server
/// reads an empty value as "restore the built-in default" and answers with
/// that default. The editor therefore sends what was typed and adopts the
/// reply, instead of trusting its own copy of what it just saved.
struct InstanceIdentitySettings: Codable, Sendable, Equatable {
    /// What the agent calls itself in prompts, messages, and the UI.
    var personaName: String?
    /// What the app calls itself in titles and headers.
    var productName: String?
    /// The short mark that stands in for the product name where space is
    /// tight. Read-only here: it is set on the web beside the wordmark it
    /// belongs to.
    var productMark: String?
    /// Where on the server the two names are stored, named in the footer so
    /// the person changing them knows what they are editing.
    var configPath: String?
}
