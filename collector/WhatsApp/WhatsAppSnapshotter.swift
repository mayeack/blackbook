import Foundation

struct WhatsAppSnapshotResult: Equatable {
    let unchanged: Bool
    let snapshotDir: String
    /// Keys `chat`, `contacts`, `lid` → absolute path of the snapshot copy, or nil if absent.
    let files: [String: String?]
    let sourceMtime: Date
    let maxPK: Int64?
    let bytes: Int64

    var json: JSON {
        .object([
            ("unchanged", .bool(unchanged)),
            ("snapshot_dir", .string(snapshotDir)),
            ("files", .object(WhatsAppSnapshotter.databases.map { ($0.key, .str(files[$0.key] ?? nil)) })),
            ("source_mtime", .iso(sourceMtime)),
            ("max_pk", .num(maxPK)),
            ("bytes", .int(bytes)),
        ])
    }
}

/// Consistent copies of WhatsApp for Mac's SQLite stores for Node to parse.
///
/// Copies `X.sqlite` and `X.sqlite-wal` — never `X.sqlite-shm`: a stale shared-memory index
/// makes every table read as empty. The copy is then checkpointed into a single
/// rollback-journal file (`wal_checkpoint(TRUNCATE)`, `journal_mode=DELETE`) and
/// `quick_check`ed. A source that changes mid-copy or fails the check is retried (3 attempts).
final class WhatsAppSnapshotter {
    struct Database { let key: String; let file: String }

    static let databases = [
        Database(key: "chat", file: "ChatStorage.sqlite"),
        Database(key: "contacts", file: "ContactsV2.sqlite"),
        Database(key: "lid", file: "LID.sqlite"),
    ]

    static var defaultSourceDir: URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Group Containers/group.net.whatsapp.WhatsApp.shared", isDirectory: true)
    }

    let sourceDir: URL
    let destRoot: URL
    let keep: Int
    let maxAttempts: Int
    private let now: () -> Date
    private let lock = NSLock()
    /// Every file name this instance copied; tests assert no `-shm` ever appears.
    private(set) var copiedFileNames: [String] = []

    init(sourceDir: URL, destRoot: URL, keep: Int = 3, maxAttempts: Int = 3, now: @escaping () -> Date = Date.init) {
        self.sourceDir = sourceDir
        self.destRoot = destRoot
        self.keep = keep
        self.maxAttempts = maxAttempts
        self.now = now
    }

    var isInstalled: Bool {
        FileManager.default.fileExists(atPath: sourceDir.appendingPathComponent(Self.databases[0].file).path)
    }

    /// Latest modification time across the main and WAL files of all three stores.
    func sourceMtime() -> Date? {
        var latest: Date?
        for db in Self.databases {
            for name in [db.file, db.file + "-wal"] {
                if let m = Self.stat(sourceDir.appendingPathComponent(name))?.mtime {
                    latest = max(latest ?? m, m)
                }
            }
        }
        return latest
    }

    func snapshot(force: Bool) throws -> WhatsAppSnapshotResult {
        lock.lock()
        defer { lock.unlock() }
        guard isInstalled else { throw APIError.whatsappNotInstalled }
        guard Self.canOpen(sourceDir.appendingPathComponent(Self.databases[0].file)) else {
            throw APIError.fdaMissing
        }
        guard let mtime = sourceMtime() else { throw APIError.whatsappNotInstalled }
        try SecureFiles.ensurePrivateDirectory(destRoot)

        if !force, let previous = loadManifest(), Self.millis(previous.sourceMtime) == Self.millis(mtime),
           FileManager.default.fileExists(atPath: previous.snapshotDir) {
            return WhatsAppSnapshotResult(unchanged: true, snapshotDir: previous.snapshotDir, files: previous.files,
                                          sourceMtime: previous.sourceMtime, maxPK: previous.maxPK, bytes: previous.bytes)
        }

        var lastFailure = "unknown"
        for attempt in 1...max(1, maxAttempts) {
            let dir = try makeSnapshotDir()
            do {
                let result = try takeSnapshot(into: dir)
                saveManifest(result)
                prune()
                return result
            } catch let failure as SnapshotFailure {
                lastFailure = failure.reason
                try? FileManager.default.removeItem(at: dir)
                if attempt < maxAttempts { Thread.sleep(forTimeInterval: 0.2 * Double(attempt)) }
            }
        }
        throw APIError.snapshotInconsistent("snapshot failed after \(maxAttempts) attempts: \(lastFailure)")
    }

    private struct SnapshotFailure: Error { let reason: String }

    private static func millis(_ d: Date) -> Int64 { Int64((d.timeIntervalSince1970 * 1000).rounded()) }

    /// TCC denials only surface at open(2), so probe with a real open.
    private static func canOpen(_ url: URL) -> Bool {
        let fd = open(url.path, O_RDONLY | O_CLOEXEC)
        guard fd >= 0 else { return false }
        close(fd)
        return true
    }

    private struct FileStat: Equatable { let size: Int64; let mtime: Date }

    private static func stat(_ url: URL) -> FileStat? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        let mtime = (attrs[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)
        return FileStat(size: size, mtime: mtime)
    }

    private func takeSnapshot(into dir: URL) throws -> WhatsAppSnapshotResult {
        let mtime = sourceMtime() ?? now()
        var files: [String: String?] = [:]
        var bytes: Int64 = 0
        var maxPK: Int64?

        for db in Self.databases {
            let main = sourceDir.appendingPathComponent(db.file)
            guard FileManager.default.fileExists(atPath: main.path) else {
                files[db.key] = .some(nil)
                continue
            }
            let wal = sourceDir.appendingPathComponent(db.file + "-wal")
            let before = (Self.stat(main), Self.stat(wal))
            // WAL first, then the main file: a checkpoint between the two leaves the copy's
            // main file at least as new as the frames we replay.
            if FileManager.default.fileExists(atPath: wal.path) {
                try copy(wal, into: dir)
            }
            try copy(main, into: dir)
            let after = (Self.stat(main), Self.stat(wal))
            guard before.0 == after.0, before.1 == after.1 else {
                throw SnapshotFailure(reason: "\(db.key) changed during copy")
            }

            let copyURL = dir.appendingPathComponent(db.file)
            try finalizeCopy(copyURL)
            if db.key == "chat" { maxPK = Self.maxMessagePK(copyURL) }
            bytes += Self.stat(copyURL)?.size ?? 0
            files[db.key] = .some(copyURL.path)
        }
        return WhatsAppSnapshotResult(unchanged: false, snapshotDir: dir.path, files: files,
                                      sourceMtime: mtime, maxPK: maxPK, bytes: bytes)
    }

    private func copy(_ source: URL, into dir: URL) throws {
        let name = source.lastPathComponent
        guard !name.hasSuffix("-shm") else { throw SnapshotFailure(reason: "refusing to copy a -shm file") }
        let dest = dir.appendingPathComponent(name)
        do {
            try FileManager.default.copyItem(at: source, to: dest)
        } catch {
            throw SnapshotFailure(reason: "copy failed for \(name)")
        }
        SecureFiles.chmodPrivate(dest)
        copiedFileNames.append(name)
    }

    /// Folds the copied WAL into the main file and verifies integrity.
    private func finalizeCopy(_ url: URL) throws {
        do {
            let conn = try SQLiteConnection(path: url.path, mode: .readWrite)
            defer { conn.close() }
            try conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            _ = try conn.scalarText("PRAGMA journal_mode=DELETE")
            let check = try conn.query("PRAGMA quick_check") { $0.text(0) ?? "" }
            guard check == ["ok"] else { throw SnapshotFailure(reason: "quick_check failed") }
        } catch let failure as SnapshotFailure {
            throw failure
        } catch {
            throw SnapshotFailure(reason: "sqlite: \(error)")
        }
        for suffix in ["-wal", "-shm", "-journal"] {
            let leftover = URL(fileURLWithPath: url.path + suffix)
            if FileManager.default.fileExists(atPath: leftover.path) { try? FileManager.default.removeItem(at: leftover) }
        }
        SecureFiles.chmodPrivate(url)
    }

    private static func maxMessagePK(_ url: URL) -> Int64? {
        guard let conn = try? SQLiteConnection(path: url.path, mode: .readOnly) else { return nil }
        defer { conn.close() }
        guard (try? conn.tableExists("ZWAMESSAGE")) == true else { return nil }
        return try? conn.scalarInt("SELECT MAX(Z_PK) FROM ZWAMESSAGE")
    }

    private func makeSnapshotDir() throws -> URL {
        let stamp = Self.stampFormatter.string(from: now())
        var dir = destRoot.appendingPathComponent(stamp, isDirectory: true)
        var n = 1
        while FileManager.default.fileExists(atPath: dir.path) {
            n += 1
            dir = destRoot.appendingPathComponent("\(stamp)-\(n)", isDirectory: true)
        }
        try SecureFiles.ensurePrivateDirectory(dir)
        return dir
    }

    private static let stampFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyyMMdd'T'HHmmss.SSS'Z'"
        return f
    }()

    // MARK: Manifest and retention

    private var manifestURL: URL { destRoot.appendingPathComponent("latest.json") }

    private func saveManifest(_ r: WhatsAppSnapshotResult) {
        let json = JSON.object([
            ("snapshot_dir", .string(r.snapshotDir)),
            ("source_mtime_ms", .int(Self.millis(r.sourceMtime))),
            ("files", .object(Self.databases.map { ($0.key, .str(r.files[$0.key] ?? nil)) })),
            ("max_pk", .num(r.maxPK)),
            ("bytes", .int(r.bytes)),
        ])
        try? SecureFiles.writePrivateFile(json.serialized(), to: manifestURL)
    }

    private func loadManifest() -> WhatsAppSnapshotResult? {
        guard let data = try? Data(contentsOf: manifestURL),
              let d = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let dir = d["snapshot_dir"] as? String,
              let ms = d["source_mtime_ms"] as? NSNumber else { return nil }
        let fileDict = d["files"] as? [String: Any] ?? [:]
        var files: [String: String?] = [:]
        for db in Self.databases { files[db.key] = .some(fileDict[db.key] as? String) }
        return WhatsAppSnapshotResult(unchanged: true, snapshotDir: dir, files: files,
                                      sourceMtime: Date(timeIntervalSince1970: ms.doubleValue / 1000),
                                      maxPK: (d["max_pk"] as? NSNumber)?.int64Value,
                                      bytes: (d["bytes"] as? NSNumber)?.int64Value ?? 0)
    }

    /// Keeps the newest `keep` snapshot directories this collector created.
    private func prune() {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: destRoot.path) else { return }
        let snapshots = names.filter { $0.range(of: #"^\d{8}T\d{6}\.\d{3}Z(-\d+)?$"#, options: .regularExpression) != nil }.sorted()
        guard snapshots.count > keep else { return }
        for name in snapshots.prefix(snapshots.count - keep) {
            try? FileManager.default.removeItem(at: destRoot.appendingPathComponent(name, isDirectory: true))
        }
    }
}
