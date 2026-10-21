import Foundation

/// One row of the Mac's call log. Values are raw: Node maps `call_type`/`provider` and normalizes the handles.
struct CallRecord: Equatable {
    let pk: Int64
    let uniqueID: String
    let date: Date
    let durationS: Double
    /// ZCALLTYPE: 1 phone, 8 FaceTime video, 16 FaceTime audio (other values pass through).
    let callType: Int64?
    /// ZSERVICE_PROVIDER, e.g. `com.apple.Telephony`, `com.apple.FaceTime`.
    let provider: String?
    let originated: Bool
    let answered: Bool
    /// The remote party (ZADDRESS) first, then any other participants of a group call, deduplicated.
    let handles: [String]

    var json: JSON {
        .object([
            ("rowid", .int(pk)),
            ("unique_id", .string(uniqueID)),
            ("date", .iso(date)),
            ("duration_s", .double(durationS)),
            ("call_type", callType.map { .int($0) } ?? .null),
            ("provider", .str(provider)),
            ("originated", .bool(originated)),
            ("answered", .bool(answered)),
            ("handles", .array(handles.map(JSON.string))),
        ])
    }
}

enum CallHistoryError: Error {
    /// CallHistory.storedata is not present (no calls ever rang this Mac).
    case notFound
    /// The file exists but cannot be opened: Full Disk Access is missing.
    case accessDenied
    case unavailable(String)
}

/// Read-only access to `~/Library/Application Support/CallHistoryDB/CallHistory.storedata`: the Core Data store
/// behind the Mac's call log (iPhone calls relayed through Continuity, and FaceTime). It only holds calls that rang
/// or were placed on this Mac, so outgoing iPhone calls and call lengths are mostly absent.
///
/// Opened like chat.db: SQLITE_OPEN_READONLY without `immutable=1`, one serialized connection, dropped and reopened
/// after a failure. Core Data numbers its join tables by entity (`Z_2REMOTEPARTICIPANTHANDLES`), so the
/// participants table and its columns are looked up by suffix instead of by name.
final class CallHistoryReader {
    static var defaultPath: String {
        NSHomeDirectory() + "/Library/Application Support/CallHistoryDB/CallHistory.storedata"
    }

    static let maxPageSize = 1000

    private struct Layout {
        let columns: Set<String>
        /// (table, call column, handle column) of the group-call participants join, if this store has one.
        let participants: (table: String, call: String, handle: String)?

        func c(_ column: String) -> String { columns.contains(column) ? column : "NULL" }
    }

    let path: String
    private let lock = NSLock()
    private var connection: SQLiteConnection?
    private var layout: Layout?

    init(path: String = CallHistoryReader.defaultPath) {
        self.path = path
    }

    /// Calls with Z_PK > `afterRowID`, oldest first.
    func calls(afterRowID: Int64, limit: Int) throws -> RowPage<CallRecord> {
        try read { conn, layout in
            let maxRowID = try conn.scalarInt("SELECT MAX(Z_PK) FROM ZCALLRECORD") ?? 0
            let rows = try conn.query(
                """
                SELECT Z_PK, \(layout.c("ZUNIQUE_ID")), ZDATE, \(layout.c("ZDURATION")), \(layout.c("ZCALLTYPE")),
                       \(layout.c("ZSERVICE_PROVIDER")), \(layout.c("ZORIGINATED")), \(layout.c("ZANSWERED")), ZADDRESS
                FROM ZCALLRECORD WHERE Z_PK > ? ORDER BY Z_PK LIMIT ?
                """,
                [.int(afterRowID), .int(Int64(limit + 1))]
            ) { r in
                (pk: r.int(0), uid: r.text(1), date: r.doubleOrNil(2), duration: r.doubleOrNil(3) ?? 0,
                 type: r.intOrNil(4), provider: r.text(5), originated: r.bool(6), answered: r.bool(7), address: r.text(8))
            }
            let hasMore = rows.count > limit
            let page = Array(rows.prefix(limit))
            var others: [Int64: [String]] = [:]
            if let p = layout.participants, let first = page.first?.pk, let last = page.last?.pk {
                for (call, value) in try conn.query(
                    "SELECT j.\(p.call), h.ZVALUE FROM \(p.table) j JOIN ZHANDLE h ON h.Z_PK = j.\(p.handle) WHERE j.\(p.call) BETWEEN ? AND ?",
                    [.int(first), .int(last)], map: { ($0.int(0), $0.text(1)) }
                ) {
                    if let value, !value.isEmpty { others[call, default: []].append(value) }
                }
            }
            let items: [CallRecord] = page.compactMap { row in
                // A call with no time can't be placed on a timeline.
                guard let seconds = row.date else { return nil }
                var handles: [String] = []
                for h in [row.address].compactMap({ $0 }) + (others[row.pk] ?? []).sorted() where !h.isEmpty && !handles.contains(h) {
                    handles.append(h)
                }
                return CallRecord(pk: row.pk, uniqueID: row.uid ?? "pk-\(row.pk)",
                                  date: Date(timeIntervalSinceReferenceDate: seconds), durationS: max(0, row.duration),
                                  callType: row.type, provider: row.provider, originated: row.originated,
                                  answered: row.answered, handles: handles)
            }
            return RowPage(items: items, nextAfterRowID: page.last?.pk ?? afterRowID, hasMore: hasMore, maxRowID: maxRowID)
        }
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        connection?.close()
        connection = nil
        layout = nil
    }

    private func read<T>(_ body: (SQLiteConnection, Layout) throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        let (conn, layout) = try openIfNeeded()
        do {
            return try body(conn, layout)
        } catch let error as SQLiteError {
            connection?.close()
            connection = nil
            self.layout = nil
            throw mapped(error)
        }
    }

    private func openIfNeeded() throws -> (SQLiteConnection, Layout) {
        if let connection, let layout { return (connection, layout) }
        guard FileManager.default.fileExists(atPath: path) else { throw CallHistoryError.notFound }
        do {
            let conn = try SQLiteConnection(path: path, mode: .readOnly)
            let columns = try conn.columns(of: "ZCALLRECORD")
            guard ["Z_PK", "ZDATE", "ZADDRESS"].allSatisfy(columns.contains) else {
                conn.close()
                throw CallHistoryError.unavailable("ZCALLRECORD is missing or has an unknown layout")
            }
            let found = Layout(columns: columns, participants: try Self.participantsJoin(conn))
            connection = conn
            layout = found
            return (conn, found)
        } catch let error as SQLiteError {
            throw mapped(error)
        }
    }

    private static func participantsJoin(_ conn: SQLiteConnection) throws -> (table: String, call: String, handle: String)? {
        guard try conn.tableExists("ZHANDLE"), try conn.columns(of: "ZHANDLE").contains("ZVALUE") else { return nil }
        let tables = try conn.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'Z%REMOTEPARTICIPANTHANDLES'") {
            $0.text(0) ?? ""
        }
        for table in tables where table.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) {
            let cols = try conn.columns(of: table)
            if let call = cols.first(where: { $0.hasSuffix("REMOTEPARTICIPANTCALLS") }),
               let handle = cols.first(where: { $0.hasSuffix("REMOTEPARTICIPANTHANDLES") }) {
                return (table, call, handle)
            }
        }
        return nil
    }

    private func mapped(_ error: SQLiteError) -> CallHistoryError {
        if error.isAccessFailure { return .accessDenied }
        return .unavailable(error.description)
    }
}
