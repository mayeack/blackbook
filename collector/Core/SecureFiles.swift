import Foundation

/// Owner-only file helpers. Everything the collector writes (token, send ledger, snapshots)
/// lives under the 0700 data directory and is created 0600 from the first byte.
enum SecureFiles {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    /// Creates `url` (and missing parents) with mode 0700, and tightens an existing
    /// directory that is group/world accessible.
    static func ensurePrivateDirectory(_ url: URL) throws {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        if fm.fileExists(atPath: url.path, isDirectory: &isDir) {
            guard isDir.boolValue else { throw Failure(description: "not a directory") }
        } else {
            try fm.createDirectory(at: url, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
        }
        let attrs = try fm.attributesOfItem(atPath: url.path)
        let mode = (attrs[.posixPermissions] as? NSNumber)?.uint16Value ?? 0
        if mode & 0o077 != 0 {
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        }
    }

    /// Writes `data` atomically with mode 0600: temp file opened 0600 + fsync + rename.
    static func writePrivateFile(_ data: Data, to url: URL) throws {
        let dir = url.deletingLastPathComponent()
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        let fd = open(tmp.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure(description: "open failed errno=\(errno)") }
        var ok = false
        defer {
            if !ok { unlink(tmp.path) }
        }
        let written = data.withUnsafeBytes { raw -> Int in
            guard let base = raw.baseAddress else { return 0 }
            var offset = 0
            while offset < raw.count {
                let n = write(fd, base.advanced(by: offset), raw.count - offset)
                if n <= 0 { return -1 }
                offset += n
            }
            return offset
        }
        fsync(fd)
        close(fd)
        guard written == data.count else { throw Failure(description: "short write") }
        guard rename(tmp.path, url.path) == 0 else { throw Failure(description: "rename failed errno=\(errno)") }
        ok = true
    }

    static func chmodPrivate(_ url: URL) {
        chmod(url.path, 0o600)
    }

    static func posixMode(_ url: URL) -> UInt16? {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.posixPermissions] as? NSNumber)?.uint16Value
    }
}
