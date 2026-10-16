import Foundation

enum ChatDBError: Error, CustomStringConvertible {
    /// chat.db is not present (Messages never set up on this Mac).
    case notFound
    /// The file exists but cannot be opened: Full Disk Access is missing.
    case accessDenied
    case unavailable(String)

    var description: String {
        switch self {
        case .notFound: return "chat.db not found"
        case .accessDenied: return "chat.db not readable (Full Disk Access missing)"
        case let .unavailable(msg): return "chat.db unavailable: \(msg)"
        }
    }
}

/// Columns that vary across macOS releases; absent ones are selected as NULL.
struct ChatDBCapabilities {
    let messageColumns: Set<String>
    let chatColumns: Set<String>

    func m(_ column: String) -> String {
        messageColumns.contains(column) ? "m.\(column)" : "NULL"
    }

    func c(_ column: String) -> String {
        chatColumns.contains(column) ? "c.\(column)" : "NULL"
    }
}

/// Persistent read-only connection to `~/Library/Messages/chat.db`.
///
/// Opened with SQLITE_OPEN_READONLY and *without* `immutable=1`, so each statement sees the
/// latest WAL commits. Calls are serialized; a failing connection is dropped and reopened on
/// the next call (e.g. after FDA is granted).
final class ChatDB {
    static var defaultPath: String { NSHomeDirectory() + "/Library/Messages/chat.db" }

    let path: String
    private let lock = NSLock()
    private var connection: SQLiteConnection?
    private var capabilities: ChatDBCapabilities?

    init(path: String = ChatDB.defaultPath) {
        self.path = path
    }

    func read<T>(_ body: (SQLiteConnection, ChatDBCapabilities) throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        let (conn, caps) = try openIfNeeded()
        do {
            return try body(conn, caps)
        } catch let error as SQLiteError {
            connection?.close()
            connection = nil
            capabilities = nil
            throw mapped(error)
        }
    }

    /// True when chat.db can be opened and read right now.
    func probe() -> Result<Void, ChatDBError> {
        do {
            _ = try read { conn, _ in try conn.scalarInt("SELECT 1") }
            return .success(())
        } catch let error as ChatDBError {
            return .failure(error)
        } catch {
            return .failure(.unavailable(String(describing: error)))
        }
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        connection?.close()
        connection = nil
        capabilities = nil
    }

    private func openIfNeeded() throws -> (SQLiteConnection, ChatDBCapabilities) {
        if let connection, let capabilities { return (connection, capabilities) }
        guard FileManager.default.fileExists(atPath: path) else { throw ChatDBError.notFound }
        do {
            let conn = try SQLiteConnection(path: path, mode: .readOnly)
            let caps = ChatDBCapabilities(messageColumns: try conn.columns(of: "message"),
                                          chatColumns: try conn.columns(of: "chat"))
            guard !caps.messageColumns.isEmpty else {
                throw ChatDBError.unavailable("message table missing")
            }
            connection = conn
            capabilities = caps
            return (conn, caps)
        } catch let error as SQLiteError {
            throw mapped(error)
        }
    }

    private func mapped(_ error: SQLiteError) -> ChatDBError {
        if error.isAccessFailure { return .accessDenied }
        return .unavailable(error.description)
    }
}
