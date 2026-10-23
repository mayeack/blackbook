import Foundation
import os

private let log = Logger(subsystem: "com.blackbookdevelopment.server", category: "ContactDates")

/// One AddressBook record: `ZABCDRECORD.ZUNIQUEID` (`<UUID>:ABPerson`), its Core Data creation time and the link id
/// that ties cards unified across accounts.
struct AddressBookRecord: Equatable {
    let uniqueID: String
    let created: Date
    let linkID: String?
}

/// CNContact identifier → when the card was created, the earliest across every AddressBook store and across
/// linked (unified) cards. Identifiers match with or without the `:ABPerson` suffix.
struct CreationDateIndex: Equatable {
    static let empty = CreationDateIndex(records: [])

    private let byID: [String: Date]

    var count: Int { byID.count }

    init(records: [AddressBookRecord]) {
        var earliest: [String: Date] = [:]
        var byLink: [String: Date] = [:]
        for r in records {
            let id = Self.baseID(r.uniqueID)
            earliest[id] = min(earliest[id] ?? r.created, r.created)
            if let link = r.linkID, !link.isEmpty { byLink[link] = min(byLink[link] ?? r.created, r.created) }
        }
        for r in records {
            guard let link = r.linkID, let linked = byLink[link] else { continue }
            let id = Self.baseID(r.uniqueID)
            earliest[id] = min(earliest[id] ?? linked, linked)
        }
        byID = earliest
    }

    func date(for identifier: String) -> Date? { byID[Self.baseID(identifier)] }

    static func baseID(_ id: String) -> String {
        id.hasSuffix(":ABPerson") ? String(id.dropLast(":ABPerson".count)) : id
    }
}

/// Reads card creation dates from the AddressBook stores, which CNContact doesn't expose
/// (`~/Library/Application Support/AddressBook/AddressBook-v22.abcddb` and `Sources/*/AddressBook-v22.abcddb`, readable
/// with the collector's Full Disk Access). The live stores are never opened: like WhatsAppSnapshotter, the `-wal` and
/// then the main file are copied (never `-shm`) into a private temporary directory, the copy is opened there (SQLite
/// replays the WAL, so cards added since the last checkpoint count), read and deleted. A store that changes mid-copy
/// (a write, or a checkpoint that removes the `-wal` under the copy) is retried with a short backoff; one that still
/// can't be read is skipped. Copies a killed process left behind are swept on the next load. Never throws: no dates
/// just means no `created_at`.
final class ContactCreationDates {
    static let storeName = "AddressBook-v22.abcddb"
    /// Private copy directories are `<scratchRoot>/yb-abcd-<UUID>`; ones older than `staleScratchAge` are leftovers.
    static let scratchPrefix = "yb-abcd-"
    static let staleScratchAge: TimeInterval = 3600

    static var defaultRoot: URL {
        URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/AddressBook", isDirectory: true)
    }

    let root: URL
    let maxAttempts: Int
    private let scratchRoot: URL
    /// Test seam: runs after each attempt's copy, before the store is re-checked for changes.
    private let afterCopy: ((_ attempt: Int) -> Void)?

    init(root: URL = ContactCreationDates.defaultRoot, maxAttempts: Int = 3,
         scratchRoot: URL = FileManager.default.temporaryDirectory, afterCopy: ((_ attempt: Int) -> Void)? = nil) {
        self.root = root
        self.maxAttempts = maxAttempts
        self.scratchRoot = scratchRoot
        self.afterCopy = afterCopy
    }

    /// The root store plus every per-account store under `Sources/`, those that exist.
    func storeURLs() -> [URL] {
        var urls = [root.appendingPathComponent(Self.storeName)]
        let sources = root.appendingPathComponent("Sources", isDirectory: true)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: sources.path)) ?? []
        urls += names.sorted().map { sources.appendingPathComponent($0, isDirectory: true).appendingPathComponent(Self.storeName) }
        return urls.filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    func load() -> CreationDateIndex {
        sweepStaleScratch()
        let stores = storeURLs()
        var records: [AddressBookRecord] = []
        var failed = 0
        for store in stores {
            if let rows = read(store) { records += rows } else { failed += 1 }
        }
        let index = CreationDateIndex(records: records)
        log.info("contact creation dates: stores=\(stores.count, privacy: .public) failed=\(failed, privacy: .public) cards=\(index.count, privacy: .public)")
        return index
    }

    /// One store's person records, read from a consistent private copy; nil when it can't be read.
    func read(_ store: URL) -> [AddressBookRecord]? {
        let scratch = scratchRoot.appendingPathComponent("\(Self.scratchPrefix)\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: scratch) }
        guard (try? SecureFiles.ensurePrivateDirectory(scratch)) != nil else { return nil }
        let wal = URL(fileURLWithPath: store.path + "-wal")
        let attempts = max(1, maxAttempts)
        for attempt in 1...attempts {
            if attempt > 1 { Thread.sleep(forTimeInterval: 0.2 * Double(attempt - 1)) }
            let dir = scratch.appendingPathComponent("\(attempt)", isDirectory: true)
            guard (try? SecureFiles.ensurePrivateDirectory(dir)) != nil else { return nil }
            let before = (Self.stat(store), Self.stat(wal))
            guard before.0 != nil else { return nil }
            let copy = dir.appendingPathComponent(Self.storeName)
            var copied = true
            do {
                // WAL first, then the main file: a checkpoint in between leaves the main copy at least as new.
                if FileManager.default.fileExists(atPath: wal.path) {
                    try FileManager.default.copyItem(at: wal, to: URL(fileURLWithPath: copy.path + "-wal"))
                }
                try FileManager.default.copyItem(at: store, to: copy)
            } catch {
                copied = false
            }
            afterCopy?(attempt)
            let unchanged = before.0 == Self.stat(store) && before.1 == Self.stat(wal)
            // A failed copy of an unchanged store is no Full Disk Access (or a vanished store): retrying won't help.
            if !copied && unchanged { return nil }
            // Torn by a write, or by a checkpoint that removed the -wal mid-copy: copy again.
            guard copied, unchanged else { continue }
            return Self.records(inCopy: copy) // a consistent copy that doesn't read won't read on a retry either
        }
        return nil
    }

    /// Removes private copies older than `staleScratchAge` (a process killed mid-read); never a read in progress.
    func sweepStaleScratch(now: Date = Date()) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: scratchRoot.path) else { return }
        for name in names where name.hasPrefix(Self.scratchPrefix) {
            let url = scratchRoot.appendingPathComponent(name, isDirectory: true)
            guard let modified = (try? fm.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date,
                  now.timeIntervalSince(modified) > Self.staleScratchAge else { continue }
            try? fm.removeItem(at: url)
        }
    }

    /// `ZABCDRECORD` person rows of a private copy (opened read-write so SQLite can replay its WAL).
    static func records(inCopy url: URL) -> [AddressBookRecord]? {
        guard let conn = try? SQLiteConnection(path: url.path, mode: .readWrite) else { return nil }
        defer { conn.close() }
        guard let columns = try? conn.columns(of: "ZABCDRECORD"),
              columns.contains("ZUNIQUEID"), columns.contains("ZCREATIONDATE") else { return nil }
        let link = columns.contains("ZLINKID") ? "ZLINKID" : "NULL"
        let rows = try? conn.query(
            "SELECT ZUNIQUEID, ZCREATIONDATE, \(link) FROM ZABCDRECORD WHERE ZUNIQUEID IS NOT NULL AND ZCREATIONDATE IS NOT NULL"
        ) { row -> AddressBookRecord? in
            guard let id = row.text(0), let seconds = row.doubleOrNil(1) else { return nil }
            // Persons only (groups and the store's info record carry other suffixes); 0 is Core Data's "unset".
            guard id.hasSuffix(":ABPerson") || !id.contains(":"), seconds.isFinite, seconds > 0 else { return nil }
            return AddressBookRecord(uniqueID: id, created: Date(timeIntervalSinceReferenceDate: seconds), linkID: row.text(2))
        }
        return rows?.compactMap { $0 }
    }

    private struct FileStat: Equatable { let size: Int64; let mtime: Date }

    private static func stat(_ url: URL) -> FileStat? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
        return FileStat(size: (attrs[.size] as? NSNumber)?.int64Value ?? 0,
                        mtime: (attrs[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0))
    }
}
