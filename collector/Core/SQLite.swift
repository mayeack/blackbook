import Foundation
import SQLite3

struct SQLiteError: Error, CustomStringConvertible {
    let code: Int32
    let message: String
    var description: String { "sqlite \(code): \(message)" }

    /// Errors that mean the file could not be opened/read at all (TCC denial shows up as CANTOPEN/PERM/AUTH).
    var isAccessFailure: Bool {
        let primary = code & 0xFF
        return primary == SQLITE_CANTOPEN || primary == SQLITE_PERM || primary == SQLITE_AUTH
    }
}

enum SQLiteValue {
    case int(Int64)
    case text(String)
    case blob(Data)
    case null
}

/// Thin wrapper over the sqlite3 C API. Not thread-safe; callers serialize access.
final class SQLiteConnection {
    enum Mode { case readOnly, readWrite, readWriteCreate }

    private(set) var handle: OpaquePointer?

    init(path: String, mode: Mode, busyTimeoutMs: Int32 = 2000) throws {
        var flags: Int32 = SQLITE_OPEN_NOMUTEX
        switch mode {
        case .readOnly: flags |= SQLITE_OPEN_READONLY
        case .readWrite: flags |= SQLITE_OPEN_READWRITE
        case .readWriteCreate: flags |= SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
        }
        var db: OpaquePointer?
        let rc = sqlite3_open_v2(path, &db, flags, nil)
        guard rc == SQLITE_OK, let db else {
            let msg = db.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            if let db { sqlite3_close(db) }
            throw SQLiteError(code: rc, message: msg)
        }
        sqlite3_extended_result_codes(db, 1)
        sqlite3_busy_timeout(db, busyTimeoutMs)
        handle = db
    }

    deinit { close() }

    func close() {
        if let handle { sqlite3_close_v2(handle) }
        handle = nil
    }

    private func db() throws -> OpaquePointer {
        guard let handle else { throw SQLiteError(code: SQLITE_MISUSE, message: "connection closed") }
        return handle
    }

    private func error(_ rc: Int32) -> SQLiteError {
        let msg = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "no connection"
        return SQLiteError(code: rc, message: msg)
    }

    func execute(_ sql: String) throws {
        let rc = sqlite3_exec(try db(), sql, nil, nil, nil)
        guard rc == SQLITE_OK else { throw error(rc) }
    }

    /// Runs `sql` with positional binds and maps every row. Statements are finalized before
    /// returning so no read transaction is held open between calls (keeps Messages' WAL healthy).
    func query<T>(_ sql: String, _ binds: [SQLiteValue] = [], map: (SQLiteRow) throws -> T) throws -> [T] {
        var stmt: OpaquePointer?
        let rc = sqlite3_prepare_v2(try db(), sql, -1, &stmt, nil)
        guard rc == SQLITE_OK, let stmt else { throw error(rc) }
        defer { sqlite3_finalize(stmt) }
        for (i, value) in binds.enumerated() {
            let idx = Int32(i + 1)
            let brc: Int32
            switch value {
            case let .int(v): brc = sqlite3_bind_int64(stmt, idx, v)
            case let .text(s): brc = sqlite3_bind_text(stmt, idx, s, -1, SQLITE_TRANSIENT_DESTRUCTOR)
            case let .blob(d):
                brc = d.withUnsafeBytes { raw in
                    sqlite3_bind_blob(stmt, idx, raw.baseAddress, Int32(raw.count), SQLITE_TRANSIENT_DESTRUCTOR)
                }
            case .null: brc = sqlite3_bind_null(stmt, idx)
            }
            guard brc == SQLITE_OK else { throw error(brc) }
        }
        var rows: [T] = []
        while true {
            let step = sqlite3_step(stmt)
            if step == SQLITE_ROW {
                rows.append(try map(SQLiteRow(stmt: stmt)))
            } else if step == SQLITE_DONE {
                break
            } else {
                throw error(step)
            }
        }
        return rows
    }

    /// Executes a single statement (with binds) that returns no rows.
    func run(_ sql: String, _ binds: [SQLiteValue] = []) throws {
        _ = try query(sql, binds) { _ in () }
    }

    var lastInsertRowID: Int64 { handle.map { sqlite3_last_insert_rowid($0) } ?? 0 }

    func scalarInt(_ sql: String, _ binds: [SQLiteValue] = []) throws -> Int64? {
        try query(sql, binds) { $0.intOrNil(0) }.first ?? nil
    }

    func scalarText(_ sql: String, _ binds: [SQLiteValue] = []) throws -> String? {
        try query(sql, binds) { $0.text(0) }.first ?? nil
    }

    func columns(of table: String) throws -> Set<String> {
        let safe = table.filter { $0.isLetter || $0.isNumber || $0 == "_" }
        return Set(try query("PRAGMA table_info(\(safe))") { $0.text(1) ?? "" })
    }

    func tableExists(_ table: String) throws -> Bool {
        try scalarInt("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", [.text(table)]) ?? 0 > 0
    }
}

let SQLITE_TRANSIENT_DESTRUCTOR = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Read-only view of the current row of a stepping statement.
struct SQLiteRow {
    let stmt: OpaquePointer

    func isNull(_ i: Int32) -> Bool { sqlite3_column_type(stmt, i) == SQLITE_NULL }

    func int(_ i: Int32) -> Int64 { sqlite3_column_int64(stmt, i) }

    func intOrNil(_ i: Int32) -> Int64? { isNull(i) ? nil : sqlite3_column_int64(stmt, i) }

    func bool(_ i: Int32) -> Bool { sqlite3_column_int64(stmt, i) != 0 }

    func text(_ i: Int32) -> String? {
        guard !isNull(i), let c = sqlite3_column_text(stmt, i) else { return nil }
        let n = Int(sqlite3_column_bytes(stmt, i))
        return String(decoding: UnsafeBufferPointer(start: c, count: n), as: UTF8.self)
    }

    func blob(_ i: Int32) -> Data? {
        guard !isNull(i) else { return nil }
        let n = Int(sqlite3_column_bytes(stmt, i))
        guard n > 0, let p = sqlite3_column_blob(stmt, i) else { return Data() }
        return Data(bytes: p, count: n)
    }
}
