import Foundation
import Testing
#if canImport(CollectorCore)
@testable import CollectorCore
#endif

/// A fake WhatsApp group container: WAL-mode stores whose newest rows live only in `-wal`
/// (auto-checkpoint off, writer connection kept open), plus a `-shm` that must never be copied.
final class FakeWhatsAppContainer {
    let root: URL
    let source: URL
    let dest: URL
    private var writers: [String: SQLiteConnection] = [:]

    init(withLID: Bool = false) throws {
        root = TestPaths.tempDir("wa")
        source = root.appendingPathComponent("group.net.whatsapp.WhatsApp.shared", isDirectory: true)
        dest = root.appendingPathComponent("Yeackbot/snapshots/whatsapp", isDirectory: true)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try makeStore("ChatStorage.sqlite", table: "ZWAMESSAGE", rows: 5)
        try makeStore("ContactsV2.sqlite", table: "ZWAADDRESSBOOKCONTACT", rows: 2)
        if withLID { try makeStore("LID.sqlite", table: "ZWAZACCOUNT", rows: 1) }
    }

    deinit {
        writers.values.forEach { $0.close() }
        try? FileManager.default.removeItem(at: root)
    }

    private func makeStore(_ name: String, table: String, rows: Int) throws {
        let conn = try SQLiteConnection(path: source.appendingPathComponent(name).path, mode: .readWriteCreate)
        _ = try conn.scalarText("PRAGMA journal_mode=WAL")
        try conn.execute("PRAGMA wal_autocheckpoint=0")
        try conn.execute("CREATE TABLE \(table) (Z_PK INTEGER PRIMARY KEY, ZTEXT TEXT)")
        writers[name] = conn
        try insert(into: name, table: table, count: rows)
    }

    func insert(into name: String, table: String, count: Int) throws {
        let conn = try #require(writers[name])
        for i in 0..<count {
            try conn.run("INSERT INTO \(table) (ZTEXT) VALUES (?)", [.text("synthetic \(i)")])
        }
    }

    func touch(_ date: Date) throws {
        for name in try FileManager.default.contentsOfDirectory(atPath: source.path) {
            try FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: source.appendingPathComponent(name).path)
        }
    }

    func snapshotter(now: @escaping () -> Date = Date.init) -> WhatsAppSnapshotter {
        WhatsAppSnapshotter(sourceDir: source, destRoot: dest, now: now)
    }
}

@Suite("WhatsApp snapshot", .serialized)
struct WhatsAppSnapshotTests {
    @Test func copiesMainAndWALNeverSHMAndFoldsWAL() throws {
        let c = try FakeWhatsAppContainer()
        let names = try FileManager.default.contentsOfDirectory(atPath: c.source.path)
        #expect(names.contains("ChatStorage.sqlite-wal"))
        #expect(names.contains("ChatStorage.sqlite-shm"), "fixture must have a -shm to prove we skip it")

        let s = c.snapshotter()
        let r = try s.snapshot(force: false)
        #expect(r.unchanged == false)
        #expect(s.copiedFileNames.sorted() == ["ChatStorage.sqlite", "ChatStorage.sqlite-wal", "ContactsV2.sqlite", "ContactsV2.sqlite-wal"])
        #expect(!s.copiedFileNames.contains { $0.hasSuffix("-shm") })

        let chat = try #require(r.files["chat"] ?? nil)
        #expect(r.files["lid"] == .some(nil))
        #expect(r.maxPK == 5, "rows that only existed in the WAL are present in the copy")
        let copy = try SQLiteConnection(path: chat, mode: .readOnly)
        defer { copy.close() }
        #expect(try copy.scalarInt("SELECT COUNT(*) FROM ZWAMESSAGE") == 5)
        #expect(try copy.scalarText("PRAGMA journal_mode") == "delete")

        let left = try FileManager.default.contentsOfDirectory(atPath: r.snapshotDir)
        #expect(left.sorted() == ["ChatStorage.sqlite", "ContactsV2.sqlite"])
        #expect(SecureFiles.posixMode(URL(fileURLWithPath: r.snapshotDir)) == 0o700)
        #expect(SecureFiles.posixMode(URL(fileURLWithPath: chat)) == 0o600)
        #expect(r.bytes > 0)

        let source = try SQLiteConnection(path: c.source.appendingPathComponent("ChatStorage.sqlite").path, mode: .readOnly)
        defer { source.close() }
        #expect(try source.scalarInt("SELECT COUNT(*) FROM ZWAMESSAGE") == 5, "source untouched")
    }

    @Test func unchangedMtimeReturnsPreviousSnapshot() throws {
        let c = try FakeWhatsAppContainer(withLID: true)
        try c.touch(refDate)
        var tick = 0
        let s = c.snapshotter(now: { tick += 1; return refDate.addingTimeInterval(Double(tick)) })
        let first = try s.snapshot(force: false)
        #expect(first.files["lid"] != .some(nil))
        let again = try s.snapshot(force: false)
        #expect(again.unchanged)
        #expect(again.snapshotDir == first.snapshotDir)
        #expect(again.maxPK == first.maxPK)

        let forced = try s.snapshot(force: true)
        #expect(forced.unchanged == false)
        #expect(forced.snapshotDir != first.snapshotDir)

        try c.insert(into: "ChatStorage.sqlite", table: "ZWAMESSAGE", count: 3)
        try c.touch(refDate.addingTimeInterval(60))
        let changed = try s.snapshot(force: false)
        #expect(changed.unchanged == false)
        #expect(changed.maxPK == 8)

        // A fresh collector process reads the manifest and still reports unchanged.
        let restarted = c.snapshotter(now: { refDate.addingTimeInterval(1000) })
        #expect(try restarted.snapshot(force: false).unchanged)
    }

    @Test func keepsOnlyNewestSnapshots() throws {
        let c = try FakeWhatsAppContainer()
        var tick = 0
        let s = c.snapshotter(now: { tick += 1; return refDate.addingTimeInterval(Double(tick)) })
        for _ in 0..<5 { _ = try s.snapshot(force: true) }
        let dirs = try FileManager.default.contentsOfDirectory(atPath: c.dest.path).filter { $0 != "latest.json" }
        #expect(dirs.count == 3)
    }

    @Test func notInstalled() throws {
        let root = TestPaths.tempDir("wa-missing")
        defer { try? FileManager.default.removeItem(at: root) }
        let s = WhatsAppSnapshotter(sourceDir: root.appendingPathComponent("nope"), destRoot: root.appendingPathComponent("out"))
        #expect(s.isInstalled == false)
        #expect(throws: APIError.whatsappNotInstalled) { try s.snapshot(force: false) }
    }

    @Test func corruptCopyIsRetriedThenReportedInconsistent() throws {
        let root = TestPaths.tempDir("wa-bad")
        defer { try? FileManager.default.removeItem(at: root) }
        let src = root.appendingPathComponent("src", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try Data(repeating: 0x42, count: 8192).write(to: src.appendingPathComponent("ChatStorage.sqlite"))
        let out = root.appendingPathComponent("out", isDirectory: true)
        let s = WhatsAppSnapshotter(sourceDir: src, destRoot: out, maxAttempts: 3)
        do {
            _ = try s.snapshot(force: false)
            Issue.record("expected snapshot_inconsistent")
        } catch let e as APIError {
            #expect(e.code == "snapshot_inconsistent")
        }
        #expect(s.copiedFileNames == ["ChatStorage.sqlite", "ChatStorage.sqlite", "ChatStorage.sqlite"])
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: out.path)) ?? []
        #expect(leftovers.isEmpty, "failed attempts are cleaned up")
    }
}
