import Foundation
import Security

/// Bearer token shared with Node through `collector.token` (0600 in the 0700 data dir).
/// Generated once (32 random bytes, base64url) and reused across launches; Node re-reads
/// the file after any 401. Residual risk (documented in PLAN): any process running as the
/// user can read the file.
struct CollectorToken {
    let value: String

    static func loadOrCreate(at url: URL) throws -> CollectorToken {
        try SecureFiles.ensurePrivateDirectory(url.deletingLastPathComponent())
        if let data = try? Data(contentsOf: url),
           let existing = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           isWellFormed(existing) {
            if let mode = SecureFiles.posixMode(url), mode & 0o077 != 0 { SecureFiles.chmodPrivate(url) }
            return CollectorToken(value: existing)
        }
        let token = CollectorToken(value: try generate())
        try SecureFiles.writePrivateFile(Data((token.value + "\n").utf8), to: url)
        return token
    }

    static func generate() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw SecureFiles.Failure(description: "SecRandomCopyBytes failed")
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func isWellFormed(_ s: String) -> Bool {
        s.count >= 43 && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// Checks an `Authorization` header value in constant time with respect to the token bytes.
    func authorizes(_ header: String?) -> Bool {
        guard let header else { return false }
        let prefix = "Bearer "
        guard header.count > prefix.count, header.prefix(prefix.count).lowercased() == prefix.lowercased() else { return false }
        let presented = header.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces)
        return Self.constantTimeEquals(Array(presented.utf8), Array(value.utf8))
    }

    static func constantTimeEquals(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        var diff = UInt8(truncatingIfNeeded: a.count ^ b.count)
        let n = max(a.count, b.count)
        for i in 0..<n {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            diff |= x ^ y
        }
        return diff == 0 && a.count == b.count
    }
}
