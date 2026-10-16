import Foundation

/// Who the collector may message: ONLY handles compiled into the signed build
/// (`collector/Generated/SelfHandles.generated.swift`, git-ignored, written by
/// `npm run setup:self`) AND currently seen as this Mac's own Messages account addresses in
/// chat.db. Not configurable over the API or from any file Node can write. With no generated
/// file the compiled list is empty and every send is refused.
struct RecipientAllowlist {
    let compiled: Set<String>
    private let ownAddresses: () throws -> Set<String>

    init(compiledHandles: [String], ownAddresses: @escaping () throws -> Set<String>) {
        self.compiled = Set(compiledHandles.map(HandleCanonical.canonical).filter { !$0.isEmpty })
        self.ownAddresses = ownAddresses
    }

    /// Fails closed: an unreadable chat.db means nothing is allowed.
    func allows(_ recipient: String) -> Bool {
        let canon = HandleCanonical.canonical(recipient)
        guard !canon.isEmpty, compiled.contains(canon) else { return false }
        guard let own = try? ownAddresses() else { return false }
        return own.contains(canon)
    }
}
