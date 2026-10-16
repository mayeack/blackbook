import Foundation

/// Idempotency record per `client_ref`: an in-memory LRU (500) persisted to
/// `send-ledger.json` (0600). A ref is marked `pending` *before* Messages is asked to send,
/// so a crash mid-send can never lead to a second send for the same ref.
final class SendLedger {
    struct Entry: Equatable {
        let ref: String
        /// A `SendStatus` raw value, or "pending".
        var status: String
        var guids: [String]
        var rowids: [Int64]
        var errorCode: String?
        var at: Date
    }

    static let pending = "pending"

    let capacity: Int
    private let fileURL: URL?
    private let lock = NSLock()
    /// Most recent last.
    private var entries: [Entry] = []

    init(fileURL: URL?, capacity: Int = 500) {
        self.fileURL = fileURL
        self.capacity = capacity
        load()
    }

    func lookup(_ ref: String) -> Entry? {
        lock.lock(); defer { lock.unlock() }
        return entries.last(where: { $0.ref == ref })
    }

    func markPending(_ ref: String, at date: Date) {
        upsert(Entry(ref: ref, status: Self.pending, guids: [], rowids: [], errorCode: nil, at: date))
    }

    func record(_ ref: String, result: SendResult, at date: Date) {
        upsert(Entry(ref: ref, status: result.status.rawValue, guids: result.messageGUIDs,
                     rowids: result.rowIDs, errorCode: result.errorCode, at: date))
    }

    /// The stored outcome as a send result. A ref left pending by a previous process is
    /// reported as unverified: it may or may not have gone out, and is never re-sent.
    static func result(from entry: Entry) -> SendResult {
        guard let status = SendStatus(rawValue: entry.status) else {
            return SendResult(status: .unverified, messageGUIDs: [], rowIDs: [], errorCode: "interrupted")
        }
        return SendResult(status: status, messageGUIDs: entry.guids, rowIDs: entry.rowids, errorCode: entry.errorCode)
    }

    private func upsert(_ entry: Entry) {
        lock.lock()
        entries.removeAll { $0.ref == entry.ref }
        entries.append(entry)
        if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
        let snapshot = entries
        lock.unlock()
        persist(snapshot)
    }

    private func persist(_ snapshot: [Entry]) {
        guard let fileURL else { return }
        let json = JSON.object([
            ("version", .num(1)),
            ("entries", .array(snapshot.map { e in
                .object([
                    ("ref", .string(e.ref)), ("status", .string(e.status)),
                    ("guids", .array(e.guids.map(JSON.string))), ("rowids", .array(e.rowids.map { .int($0) })),
                    ("error_code", .str(e.errorCode)), ("at", .iso(e.at)),
                ])
            })),
        ])
        try? SecureFiles.writePrivateFile(json.serialized(), to: fileURL)
    }

    private func load() {
        guard let fileURL, let data = try? Data(contentsOf: fileURL),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = root["entries"] as? [[String: Any]] else { return }
        entries = list.compactMap { d in
            guard let ref = d["ref"] as? String, let status = d["status"] as? String else { return nil }
            return Entry(ref: ref, status: status,
                         guids: d["guids"] as? [String] ?? [],
                         rowids: (d["rowids"] as? [NSNumber] ?? []).map(\.int64Value),
                         errorCode: d["error_code"] as? String,
                         at: (d["at"] as? String).flatMap(ISOTime.parse) ?? Date(timeIntervalSince1970: 0))
        }
        if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
    }
}
