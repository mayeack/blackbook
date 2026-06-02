import Foundation
import Observation
import SwiftData
import SQLite3
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.server", category: "IMessageSync")

/// Polls the local iMessage database (chat.db) and creates Interaction records in the master
/// store for messages sent to or received from Blackbook contacts.
///
/// This lives in **BlackbookServer** (un-sandboxed, always-running) rather than the main app:
/// the main macOS app ships sandboxed via TestFlight and cannot read `~/Library/Messages/chat.db`.
/// The server is un-sandboxed and only needs Full Disk Access granted once. Interactions it creates
/// in the master store flow to iOS and macOS clients automatically via `/sync/changes` (the pull
/// query serves records by `updatedAt`, so freshly-created interactions are picked up).
@Observable
final class IMessageSyncService {

    enum Const {
        // chat.db lives in the real user home. NSUserName() is correct regardless of sandbox state.
        static let chatDBPath = "/Users/\(NSUserName())/Library/Messages/chat.db"
        static let pollIntervalSeconds: TimeInterval = 30
        static let batchLimit: Int64 = 500
        static let lastProcessedROWIDKey = "iMessageSync.lastProcessedROWID"
        static let enabledKey = "iMessageSync.enabled"
    }

    @ObservationIgnored private var db: OpaquePointer?
    @ObservationIgnored private var pollTimer: Timer?
    @ObservationIgnored private let modelContainer: ModelContainer?
    @ObservationIgnored private let context: ModelContext?
    @ObservationIgnored private let defaults = UserDefaults(suiteName: "com.blackbookdevelopment.server") ?? .standard

    var isRunning = false
    var lastSyncDate: Date?
    var syncError: String?
    var messagesProcessed: Int = 0
    var isBackfilling = false
    /// Handles seen in the most recent poll that did not match any contact (capped at 20).
    /// Lets the user diagnose "why isn't Nick logging?" — his handle shows here if unmatched.
    var unmatchedHandlesLastPoll: [String] = []

    private var lastProcessedROWID: Int64 {
        get { Int64(defaults.integer(forKey: Const.lastProcessedROWIDKey)) }
        set { defaults.set(Int(newValue), forKey: Const.lastProcessedROWIDKey) }
    }

    var isEnabled: Bool {
        get { defaults.bool(forKey: Const.enabledKey) }
        set {
            defaults.set(newValue, forKey: Const.enabledKey)
            if newValue { start() } else { stop() }
        }
    }

    init(modelContainer: ModelContainer?) {
        self.modelContainer = modelContainer
        self.context = modelContainer.map { ModelContext($0) }
    }

    deinit {
        stop()
    }

    // MARK: - Lifecycle

    /// Starts polling if the feature is enabled. Call once from server startup.
    func startIfEnabled() {
        guard isEnabled else {
            logger.info("iMessage sync disabled — skipping")
            return
        }
        start()
    }

    func start() {
        guard !isRunning else { return }
        guard context != nil else {
            syncError = "Master store unavailable — cannot log iMessages."
            return
        }
        guard openDatabase() else { return }

        // On first run, seed the cursor to the current max so we don't import the whole history.
        if lastProcessedROWID == 0 {
            seedLastROWID()
        }

        isRunning = true
        syncError = nil
        logger.info("iMessage sync started — polling every \(Const.pollIntervalSeconds)s")

        pollNewMessages()
        pollTimer = Timer.scheduledTimer(
            withTimeInterval: Const.pollIntervalSeconds,
            repeats: true
        ) { [weak self] _ in
            self?.pollNewMessages()
        }
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
        closeDatabase()
        isRunning = false
        logger.info("iMessage sync stopped")
    }

    // MARK: - SQLite Access

    private func openDatabase() -> Bool {
        let path = Const.chatDBPath

        guard FileManager.default.fileExists(atPath: path) else {
            syncError = "chat.db not found at \(path). Ensure Messages is set up on this Mac."
            logger.error("chat.db not found at \(path)")
            return false
        }

        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX
        let result = sqlite3_open_v2(path, &db, flags, nil)
        guard result == SQLITE_OK else {
            let msg = String(cString: sqlite3_errmsg(db))
            syncError = "Cannot open chat.db: \(msg). Grant Full Disk Access to Blackbook Server in System Settings."
            logger.error("sqlite3_open_v2 failed: \(msg)")
            db = nil
            return false
        }

        logger.info("Opened chat.db read-only")
        return true
    }

    private func closeDatabase() {
        if let db {
            sqlite3_close(db)
            self.db = nil
        }
    }

    /// Sets the ROWID cursor to the current max so we only process future messages.
    private func seedLastROWID() {
        guard let db else { return }
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, "SELECT MAX(ROWID) FROM message", -1, &stmt, nil) == SQLITE_OK,
           sqlite3_step(stmt) == SQLITE_ROW {
            let maxID = sqlite3_column_int64(stmt, 0)
            lastProcessedROWID = maxID
            logger.info("Seeded lastProcessedROWID to \(maxID)")
        }
        sqlite3_finalize(stmt)
    }

    // MARK: - Backfill

    /// Resets the cursor to import every message from the last N days, then runs poll cycles
    /// until the cursor catches up.
    @MainActor
    func backfill(daysBack: Int) async {
        guard isRunning, let db else {
            syncError = "Enable iMessage Sync before running a backfill."
            return
        }
        guard !isBackfilling else { return }
        isBackfilling = true
        defer { isBackfilling = false }

        let cutoff = Date().addingTimeInterval(-Double(daysBack) * 86_400)
        let cutoffTimestamp = imessageTimestamp(from: cutoff)

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT MIN(ROWID) FROM message WHERE date >= ?1", -1, &stmt, nil) == SQLITE_OK else {
            syncError = "Backfill query failed: \(String(cString: sqlite3_errmsg(db)))"
            return
        }
        sqlite3_bind_int64(stmt, 1, cutoffTimestamp)
        var startROWID: Int64 = 0
        if sqlite3_step(stmt) == SQLITE_ROW {
            startROWID = sqlite3_column_int64(stmt, 0)
        }
        sqlite3_finalize(stmt)

        guard startROWID > 0 else {
            logger.info("Backfill: no messages within the last \(daysBack) days")
            lastSyncDate = Date()
            return
        }

        lastProcessedROWID = startROWID - 1
        logger.info("Backfill: resetting cursor to \(startROWID - 1), importing \(daysBack) days")

        var iterations = 0
        while iterations < 1000 {
            let processed = pollNewMessages()
            iterations += 1
            if processed < Const.batchLimit { break }
            await Task.yield()
        }
        logger.info("Backfill complete: \(self.messagesProcessed) messages logged across \(iterations) batches")
    }

    // MARK: - Polling

    /// Polls for new messages above the cursor, inserts matching Interactions, advances the cursor.
    /// Returns the number of rows fetched (matched + unmatched) so the backfill loop knows whether
    /// another batch remains.
    @discardableResult
    private func pollNewMessages() -> Int64 {
        guard let db, let context else { return 0 }

        let sql = """
            SELECT m.ROWID, m.text, m.is_from_me, m.date, h.id
            FROM message m
            JOIN handle h ON m.handle_id = h.ROWID
            WHERE m.ROWID > ?1 AND m.text IS NOT NULL AND m.text != ''
            ORDER BY m.ROWID ASC
            LIMIT \(Const.batchLimit)
            """

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            let msg = String(cString: sqlite3_errmsg(db))
            syncError = "Query failed: \(msg)"
            logger.error("prepare failed: \(msg)")
            return 0
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_int64(stmt, 1, lastProcessedROWID)

        let contacts: [Contact]
        do {
            // Exclude merged-away and hidden contacts — they're "dead" pointers from the user's
            // perspective. If a live duplicate and a merged-away version both share a phone or
            // email, the handle-lookup dict-assignment order can pick the merged-away one, which
            // makes the iMessage invisible on the live contact's detail view (observed
            // 2026-06-02 with Hugo Dooner: 4 messages attached to merged-away Z_PK 1210
            // instead of live Z_PK 313).
            let predicate = #Predicate<Contact> { !$0.isMergedAway && !$0.isHidden }
            contacts = try context.fetch(FetchDescriptor<Contact>(predicate: predicate))
        } catch {
            syncError = "Failed to fetch contacts: \(error.localizedDescription)"
            logger.error("Contact fetch failed: \(error)")
            return 0
        }

        let lookup = buildHandleLookup(contacts: contacts)

        struct PendingRow {
            let text: String
            let isFromMe: Bool
            let date: Date
            let contact: Contact
        }

        var pending: [PendingRow] = []
        var highestROWID = lastProcessedROWID
        var rowCount: Int64 = 0
        var unmatched: [String] = []

        while sqlite3_step(stmt) == SQLITE_ROW {
            rowCount += 1
            let rowid = sqlite3_column_int64(stmt, 0)
            let text = sqlite3_column_text(stmt, 1).map { String(cString: $0) } ?? ""
            let isFromMe = sqlite3_column_int(stmt, 2) == 1
            let dateValue = sqlite3_column_int64(stmt, 3)
            let handleId = sqlite3_column_text(stmt, 4).map { String(cString: $0) } ?? ""

            highestROWID = max(highestROWID, rowid)

            guard let contact = lookup(handleId) else {
                if unmatched.count < 20, !unmatched.contains(handleId) {
                    unmatched.append(handleId)
                }
                continue
            }

            pending.append(PendingRow(
                text: text,
                isFromMe: isFromMe,
                date: dateFromIMesssageTimestamp(dateValue),
                contact: contact
            ))
        }

        unmatchedHandlesLastPoll = unmatched

        guard !pending.isEmpty else {
            lastProcessedROWID = highestROWID
            lastSyncDate = Date()
            syncError = nil
            return rowCount
        }

        // Dedup: skip any (contact, second-truncated date, summary) we already stored. Protects the
        // backfill path and any future ROWID reset (e.g. a chat.db rebuild).
        let earliest = pending.map(\.date).min() ?? Date()
        let latest = pending.map(\.date).max() ?? Date()
        var existingKeys = Set<String>()
        do {
            var descriptor = FetchDescriptor<Interaction>(
                predicate: #Predicate { $0.date >= earliest && $0.date <= latest }
            )
            descriptor.fetchLimit = 5000
            for ix in try context.fetch(descriptor) {
                guard let cid = ix.contact?.id else { continue }
                existingKeys.insert(dedupKey(contactId: cid, date: ix.date, summary: ix.summary))
            }
        } catch {
            logger.warning("Dedup fetch failed (\(error.localizedDescription)) — proceeding without dedup")
        }

        var newCount = 0
        for row in pending {
            let key = dedupKey(contactId: row.contact.id, date: row.date, summary: row.text)
            if existingKeys.contains(key) { continue }
            existingKeys.insert(key)

            let interaction = Interaction(
                contact: row.contact,
                type: .text,
                date: row.date,
                summary: row.text
            )
            interaction.messageDirection = row.isFromMe ? .sent : .received
            context.insert(interaction)

            if row.contact.lastInteractionDate == nil || row.date > row.contact.lastInteractionDate! {
                row.contact.lastInteractionDate = row.date
                row.contact.updatedAt = Date()
            }
            newCount += 1
        }

        if newCount > 0 {
            do {
                try context.save()
                messagesProcessed += newCount
                logger.info("Logged \(newCount) new iMessage interaction(s)")
            } catch {
                syncError = "Failed to save: \(error.localizedDescription)"
                logger.error("Save failed: \(error)")
                return rowCount
            }
        }

        lastProcessedROWID = highestROWID
        lastSyncDate = Date()
        syncError = nil
        return rowCount
    }

    private func dedupKey(contactId: UUID, date: Date, summary: String?) -> String {
        let seconds = Int64(date.timeIntervalSince1970)
        return "\(contactId.uuidString)|\(seconds)|\(summary ?? "")"
    }

    // MARK: - Handle Matching

    /// Returns a closure mapping a raw chat.db `handle.id` to a Contact, indexing both phone
    /// numbers (last-10-digits) and emails (lowercased) so Apple-ID-email threads also match.
    private func buildHandleLookup(contacts: [Contact]) -> (String) -> Contact? {
        var phoneMap: [String: Contact] = [:]
        var emailMap: [String: Contact] = [:]
        for contact in contacts {
            for phone in contact.phones {
                let normalized = normalizePhoneNumber(phone)
                if !normalized.isEmpty { phoneMap[normalized] = contact }
            }
            for email in contact.emails {
                let normalized = normalizeEmail(email)
                if !normalized.isEmpty { emailMap[normalized] = contact }
            }
        }
        return { handleId in
            if handleId.contains("@") {
                return emailMap[self.normalizeEmail(handleId)]
            } else {
                return phoneMap[self.normalizePhoneNumber(handleId)]
            }
        }
    }

    /// Strips a phone string to its last 10 digits for comparison.
    private func normalizePhoneNumber(_ raw: String) -> String {
        let digits = raw.filter(\.isWholeNumber)
        return digits.count >= 10 ? String(digits.suffix(10)) : digits
    }

    private func normalizeEmail(_ raw: String) -> String {
        raw.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Date Conversion

    /// Modern chat.db stores message dates as nanoseconds since 2001-01-01; older ones used seconds.
    private func dateFromIMesssageTimestamp(_ timestamp: Int64) -> Date {
        let reference = Date(timeIntervalSinceReferenceDate: 0)
        if timestamp > 1_000_000_000 {
            return reference.addingTimeInterval(TimeInterval(timestamp) / 1_000_000_000)
        } else {
            return reference.addingTimeInterval(TimeInterval(timestamp))
        }
    }

    /// Inverse of `dateFromIMesssageTimestamp` — nanoseconds-since-2001 form used by modern chat.db.
    private func imessageTimestamp(from date: Date) -> Int64 {
        Int64(date.timeIntervalSinceReferenceDate * 1_000_000_000)
    }
}
