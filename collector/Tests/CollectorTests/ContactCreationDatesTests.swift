import Foundation
import Testing
#if canImport(CollectorCore)
@testable import CollectorCore
#endif

// Synthetic AddressBook stores: invented record ids in a temp directory shaped like
// ~/Library/Application Support/AddressBook (root store + Sources/<account>/ stores).

private func coreData(_ iso: String) -> Double { ISOTime.parse(iso)!.timeIntervalSinceReferenceDate }
private func date(_ iso: String) -> Date { ISOTime.parse(iso)! }

private struct Row {
    var id: String
    var created: Double?
    var link: String? = nil
}

/// Creates a store with the AddressBook columns the reader needs. `wal` keeps the returned connection open with
/// autocheckpoint off, so every row exists only in the `-wal` file until the caller closes it.
@discardableResult
private func makeStore(_ url: URL, _ rows: [Row], wal: Bool = false, columns: String = "ZUNIQUEID VARCHAR, ZCREATIONDATE TIMESTAMP, ZLINKID VARCHAR") throws -> SQLiteConnection {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let conn = try SQLiteConnection(path: url.path, mode: .readWriteCreate)
    // The table goes into the main file first (like a real store, never an empty main file); the rows follow.
    try conn.execute("CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, \(columns))")
    if wal {
        _ = try conn.scalarText("PRAGMA journal_mode=WAL")
        try conn.execute("PRAGMA wal_autocheckpoint=0")
    }
    for r in rows {
        // TIMESTAMP has NUMERIC affinity, so the decimal text is stored as a number, as Core Data's REAL is.
        var names = ["ZUNIQUEID"], values: [SQLiteValue] = [.text(r.id)]
        if columns.contains("ZCREATIONDATE") { names.append("ZCREATIONDATE"); values.append(r.created.map { .text(String($0)) } ?? .null) }
        if columns.contains("ZLINKID") { names.append("ZLINKID"); values.append(r.link.map { .text($0) } ?? .null) }
        try conn.run("INSERT INTO ZABCDRECORD (Z_ENT, \(names.joined(separator: ", "))) VALUES (22, \(names.map { _ in "?" }.joined(separator: ", ")))",
                     values)
    }
    if !wal { conn.close() }
    return conn
}

@Suite("contact creation dates")
struct ContactCreationDatesTests {
    @Test func earliestAcrossStoresLinksAndTheWAL() throws {
        let root = TestPaths.tempDir("addressbook")
        let scratch = TestPaths.tempDir("abscratch")
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: scratch)
        }
        let store = ContactCreationDates.storeName
        try makeStore(root.appendingPathComponent(store), [
            Row(id: "PERSON-0001:ABPerson", created: coreData("2026-03-03T18:00:00.000Z")),
            Row(id: "GROUP-0001:ABGroup", created: coreData("2020-01-01T00:00:00.000Z")),
            Row(id: "PERSON-0009:ABPerson", created: 0),
            Row(id: "PERSON-0010:ABPerson", created: nil),
        ])
        try makeStore(root.appendingPathComponent("Sources/ACCOUNT-ONE/\(store)"), [
            Row(id: "PERSON-0001:ABPerson", created: coreData("2024-05-01T10:00:00.000Z")),
            Row(id: "PERSON-0002:ABPerson", created: coreData("2025-01-01T08:00:00.000Z"), link: "LINK-A"),
        ])
        // Every row of this store is still in its WAL (an open writer, no checkpoint): the copy must replay it.
        let walStore = root.appendingPathComponent("Sources/ACCOUNT-TWO/\(store)")
        let writer = try makeStore(walStore, [
            Row(id: "PERSON-0003:ABPerson", created: coreData("2026-10-20T23:15:00.000Z")),
            Row(id: "PERSON-0004:ABPerson", created: coreData("2026-01-01T12:00:00.000Z"), link: "LINK-A"),
            Row(id: "PERSON-0005", created: coreData("2026-02-02T02:02:00.000Z")),
        ], wal: true)
        defer { writer.close() }
        let walBefore = try FileManager.default.attributesOfItem(atPath: walStore.path + "-wal")[.size] as? NSNumber
        let mainBefore = try FileManager.default.attributesOfItem(atPath: walStore.path)[.modificationDate] as? Date
        // An unreadable store is skipped; the others still count.
        let bad = root.appendingPathComponent("Sources/ACCOUNT-BAD/\(store)")
        try FileManager.default.createDirectory(at: bad.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("not a database".utf8).write(to: bad)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Sources/ACCOUNT-EMPTY"), withIntermediateDirectories: true)

        let reader = ContactCreationDates(root: root, scratchRoot: scratch)
        #expect(reader.storeURLs().count == 4, "root + three account stores that exist")
        let index = reader.load()
        #expect(index.date(for: "PERSON-0001:ABPerson") == date("2024-05-01T10:00:00.000Z"), "earliest across stores")
        #expect(index.date(for: "PERSON-0001") == date("2024-05-01T10:00:00.000Z"), "the bare id matches too")
        #expect(index.date(for: "PERSON-0002:ABPerson") == date("2025-01-01T08:00:00.000Z"))
        #expect(index.date(for: "PERSON-0004:ABPerson") == date("2025-01-01T08:00:00.000Z"), "a linked card takes the earliest of its links")
        #expect(index.date(for: "PERSON-0003:ABPerson") == date("2026-10-20T23:15:00.000Z"), "WAL-only rows are read")
        #expect(index.date(for: "PERSON-0005:ABPerson") == date("2026-02-02T02:02:00.000Z"))
        #expect(index.date(for: "GROUP-0001:ABGroup") == nil)
        #expect(index.date(for: "PERSON-0009:ABPerson") == nil, "0 is Core Data's unset")
        #expect(index.date(for: "PERSON-0010:ABPerson") == nil)
        #expect(index.date(for: "PERSON-0404:ABPerson") == nil)
        #expect(index.count == 5)

        // The live store is untouched and the private copies are gone.
        #expect(try FileManager.default.attributesOfItem(atPath: walStore.path + "-wal")[.size] as? NSNumber == walBefore)
        #expect(try FileManager.default.attributesOfItem(atPath: walStore.path)[.modificationDate] as? Date == mainBefore)
        #expect(try FileManager.default.contentsOfDirectory(atPath: scratch.path).isEmpty)
    }

    @Test func missingStoresOrColumnsMeanNoDates() throws {
        let root = TestPaths.tempDir("addressbook")
        defer { try? FileManager.default.removeItem(at: root) }
        #expect(ContactCreationDates(root: root.appendingPathComponent("absent")).load() == .empty)

        let store = root.appendingPathComponent(ContactCreationDates.storeName)
        try makeStore(store, [Row(id: "PERSON-0001:ABPerson", created: nil)], columns: "ZUNIQUEID VARCHAR")
        let reader = ContactCreationDates(root: root)
        #expect(reader.read(store) == nil)
        #expect(reader.load().count == 0)

        // No ZLINKID column (an older store layout) still reads.
        let older = root.appendingPathComponent("Sources/OLD/\(ContactCreationDates.storeName)")
        try makeStore(older, [Row(id: "PERSON-0002:ABPerson", created: coreData("2023-03-03T03:03:03.000Z"))],
                      columns: "ZUNIQUEID VARCHAR, ZCREATIONDATE TIMESTAMP")
        #expect(reader.load().date(for: "PERSON-0002") == date("2023-03-03T03:03:03.000Z"))
    }

    @Test func aStoreChangedMidCopyIsCopiedAgain() throws {
        let root = TestPaths.tempDir("addressbook")
        let scratch = TestPaths.tempDir("abscratch")
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: scratch)
        }
        let store = root.appendingPathComponent(ContactCreationDates.storeName)
        try makeStore(store, [Row(id: "PERSON-0001:ABPerson", created: coreData("2025-05-05T05:05:05.000Z"))])
        var attempts: [Int] = []
        // A write lands between the copy and the re-check: the first copy may be torn, so it is never used.
        let reader = ContactCreationDates(root: root, scratchRoot: scratch, afterCopy: { attempt in
            attempts.append(attempt)
            guard attempt == 1 else { return }
            let w = try? SQLiteConnection(path: store.path, mode: .readWrite)
            try? w?.run("INSERT INTO ZABCDRECORD (Z_ENT, ZUNIQUEID, ZCREATIONDATE) VALUES (22, ?, ?)",
                        [.text("PERSON-0002:ABPerson"), .text(String(coreData("2026-06-06T06:06:06.000Z")))])
            w?.close()
        })
        let rows = try #require(reader.read(store))
        #expect(attempts == [1, 2])
        #expect(Set(rows.map(\.uniqueID)) == ["PERSON-0001:ABPerson", "PERSON-0002:ABPerson"], "the second, consistent copy is read")
        #expect(try FileManager.default.contentsOfDirectory(atPath: scratch.path).isEmpty)

        // Always changing: every attempt is torn, so the store is skipped rather than read inconsistently.
        var tries = 0
        let busy = ContactCreationDates(root: root, maxAttempts: 2, scratchRoot: scratch, afterCopy: { _ in
            tries += 1
            let w = try? SQLiteConnection(path: store.path, mode: .readWrite)
            try? w?.run("INSERT INTO ZABCDRECORD (Z_ENT, ZUNIQUEID, ZCREATIONDATE) VALUES (22, ?, ?)",
                        [.text("PERSON-01\(tries):ABPerson"), .text("1000")])
            w?.close()
        })
        #expect(busy.read(store) == nil)
        #expect(tries == 2)
    }

    @Test func anUnreadableStoreIsSkippedWithoutRetriesUnlessItChanged() throws {
        let root = TestPaths.tempDir("addressbook")
        let scratch = TestPaths.tempDir("abscratch")
        let store = root.appendingPathComponent(ContactCreationDates.storeName)
        defer {
            chmod(store.path, 0o600)
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: scratch)
        }
        try makeStore(store, [Row(id: "PERSON-0001:ABPerson", created: coreData("2025-05-05T05:05:05.000Z"))])
        // No Full Disk Access looks like this: the copy fails and nothing changed, so one attempt is enough.
        #expect(chmod(store.path, 0) == 0)
        var attempts = 0
        let denied = ContactCreationDates(root: root, scratchRoot: scratch, afterCopy: { _ in attempts += 1 })
        #expect(denied.read(store) == nil)
        #expect(attempts == 1)
        #expect(denied.load() == .empty)

        // A copy that failed while the store changed (its -wal checkpointed away) is tried again.
        var seen: [Int] = []
        let racing = ContactCreationDates(root: root, scratchRoot: scratch, afterCopy: { attempt in
            seen.append(attempt)
            guard attempt == 1 else { return }
            chmod(store.path, 0o600)
            let w = try? SQLiteConnection(path: store.path, mode: .readWrite)
            try? w?.run("INSERT INTO ZABCDRECORD (Z_ENT, ZUNIQUEID, ZCREATIONDATE) VALUES (22, ?, ?)",
                        [.text("PERSON-0002:ABPerson"), .text(String(coreData("2026-06-06T06:06:06.000Z")))])
            w?.close()
        })
        #expect(racing.read(store)?.count == 2)
        #expect(seen == [1, 2])
        #expect(try FileManager.default.contentsOfDirectory(atPath: scratch.path).isEmpty)
    }

    @Test func loadSweepsCopiesAKilledProcessLeftBehind() throws {
        let root = TestPaths.tempDir("addressbook")
        let scratch = TestPaths.tempDir("abscratch")
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: scratch)
        }
        let fm = FileManager.default
        func dir(_ name: String, age: TimeInterval) throws -> URL {
            let url = scratch.appendingPathComponent(name, isDirectory: true)
            try fm.createDirectory(at: url.appendingPathComponent("1"), withIntermediateDirectories: true)
            try Data("copy".utf8).write(to: url.appendingPathComponent("1/\(ContactCreationDates.storeName)"))
            try fm.setAttributes([.modificationDate: Date().addingTimeInterval(-age)], ofItemAtPath: url.path)
            return url
        }
        let stale = try dir("\(ContactCreationDates.scratchPrefix)STALE", age: ContactCreationDates.staleScratchAge + 60)
        let inFlight = try dir("\(ContactCreationDates.scratchPrefix)INFLIGHT", age: 5)
        let unrelated = try dir("someone-else", age: 10 * ContactCreationDates.staleScratchAge)

        _ = ContactCreationDates(root: root.appendingPathComponent("absent"), scratchRoot: scratch).load()
        #expect(!fm.fileExists(atPath: stale.path), "a leftover copy is removed")
        #expect(fm.fileExists(atPath: inFlight.path), "a read in progress is never touched")
        #expect(fm.fileExists(atPath: unrelated.path), "only the reader's own directories")
    }

    @Test func indexKeepsTheEarliestDate() {
        let index = CreationDateIndex(records: [
            AddressBookRecord(uniqueID: "P-1:ABPerson", created: date("2026-01-02T00:00:00.000Z"), linkID: nil),
            AddressBookRecord(uniqueID: "P-1", created: date("2026-01-01T00:00:00.000Z"), linkID: ""),
            AddressBookRecord(uniqueID: "P-2:ABPerson", created: date("2026-05-01T00:00:00.000Z"), linkID: "L"),
            AddressBookRecord(uniqueID: "P-3:ABPerson", created: date("2026-04-01T00:00:00.000Z"), linkID: "L"),
        ])
        #expect(index.date(for: "P-1:ABPerson") == date("2026-01-01T00:00:00.000Z"))
        #expect(index.date(for: "P-2:ABPerson") == date("2026-04-01T00:00:00.000Z"))
        #expect(index.date(for: "P-3") == date("2026-04-01T00:00:00.000Z"))
        #expect(CreationDateIndex.baseID("X:ABPerson") == "X")
        #expect(CreationDateIndex.baseID("X:ABGroup") == "X:ABGroup")
    }
}
