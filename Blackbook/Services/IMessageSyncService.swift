#if os(macOS)
import Foundation
import Observation
import SwiftData
import SQLite3
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "IMessageSync")

/// Continuously polls the local iMessage database (chat.db) and creates
/// Interaction records for messages sent to or received from Blackbook contacts.
@Observable
final class IMessageSyncService {
    private var db: OpaquePointer?
    private var pollTimer: Timer?
    private weak var modelContext: ModelContext?

    var isRunning = false
    var lastSyncDate: Date?
    var syncError: String?
    var messagesProcessed: Int = 0

    private var lastProcessedROWID: Int64 {
        get { Int64(UserDefaults.standard.integer(forKey: AppConstants.IMessageSync.lastProcessedROWIDKey)) }
        set { UserDefaults.standard.set(Int(newValue), forKey: AppConstants.IMessageSync.lastProcessedROWIDKey) }
    }

    var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: AppConstants.IMessageSync.enabledKey) }
        set {
            UserDefaults.standard.set(newValue, forKey: AppConstants.IMessageSync.enabledKey)
            if newValue { start() } else { stop() }
        }
    }

    deinit {
        stop()
    }

    // MARK: - Lifecycle

    /// Starts polling if the feature is enabled. Call once from app startup with the main ModelContext.
    func startIfEnabled(with context: ModelContext) {
        self.modelContext = context
        guard isEnabled else {
            logger.info("iMessage sync disabled — skipping")
            return
        }
        start()
    }

    func start() {
        guard !isRunning else { return }

        guard openDatabase() else { return }

        // If first launch, seed the ROWID to now so we don't import the entire history
        if lastProcessedROWID == 0 {
            seedLastROWID()
        }

        isRunning = true
        syncError = nil
        logger.info("iMessage sync started — polling every \(AppConstants.IMessageSync.pollIntervalSeconds)s")

        // Run immediately, then on timer
        pollNewMessages()

        pollTimer = Timer.scheduledTimer(
            withTimeInterval: AppConstants.IMessageSync.pollIntervalSeconds,
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
        let path = AppConstants.IMessageSync.chatDBPath

        guard FileManager.default.fileExists(atPath: path) else {
            syncError = "chat.db not found. Ensure Messages is set up on this Mac."
            logger.error("chat.db not found at \(path)")
            return false
        }

        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX
        let result = sqlite3_open_v2(path, &db, flags, nil)
        guard result == SQLITE_OK else {
            let msg = String(cString: sqlite3_errmsg(db))
            syncError = "Cannot open chat.db: \(msg). Grant Full Disk Access to this app in System Settings."
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
        let sql = "SELECT MAX(ROWID) FROM message"
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK,
           sqlite3_step(stmt) == SQLITE_ROW {
            let maxID = sqlite3_column_int64(stmt, 0)
            lastProcessedROWID = maxID
            logger.info("Seeded lastProcessedROWID to \(maxID)")
        }
        sqlite3_finalize(stmt)
    }

    // MARK: - Polling

    private func pollNewMessages() {
        guard let db, let modelContext else { return }

        let sql = """
            SELECT m.ROWID, m.text, m.is_from_me, m.date, h.id
            FROM message m
            JOIN handle h ON m.handle_id = h.ROWID
            WHERE m.ROWID > ?1 AND m.text IS NOT NULL AND m.text != ''
            ORDER BY m.ROWID ASC
            LIMIT 500
            """

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            let msg = String(cString: sqlite3_errmsg(db))
            syncError = "Query failed: \(msg)"
            logger.error("prepare failed: \(msg)")
            return
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_int64(stmt, 1, lastProcessedROWID)

        // Fetch all contacts once per poll cycle for matching
        let contacts: [Contact]
        do {
            contacts = try modelContext.fetch(FetchDescriptor<Contact>())
        } catch {
            syncError = "Failed to fetch contacts: \(error.localizedDescription)"
            logger.error("Contact fetch failed: \(error)")
            return
        }

        // Build a lookup: normalized phone digits (last 10) → Contact
        let phoneLookup = buildPhoneLookup(contacts: contacts)

        var highestROWID = lastProcessedROWID
        var newCount = 0

        while sqlite3_step(stmt) == SQLITE_ROW {
            let rowid = sqlite3_column_int64(stmt, 0)
            let text = sqlite3_column_text(stmt, 1).map { String(cString: $0) } ?? ""
            let isFromMe = sqlite3_column_int(stmt, 2) == 1
            let dateValue = sqlite3_column_int64(stmt, 3)
            let handleId = sqlite3_column_text(stmt, 4).map { String(cString: $0) } ?? ""

            highestROWID = max(highestROWID, rowid)

            // Normalize handle and look up contact
            let normalizedHandle = normalizePhoneNumber(handleId)
            guard let contact = phoneLookup[normalizedHandle] else {
                continue // Not a Blackbook contact
            }

            // Convert iMessage date (nanoseconds since 2001-01-01) to Date
            let messageDate = dateFromIMesssageTimestamp(dateValue)

            let interaction = Interaction(
                contact: contact,
                type: .text,
                date: messageDate,
                summary: text
            )
            interaction.messageDirection = isFromMe ? .sent : .received

            modelContext.insert(interaction)

            // Update contact's last interaction date
            if contact.lastInteractionDate == nil || messageDate > contact.lastInteractionDate! {
                contact.lastInteractionDate = messageDate
                contact.updatedAt = Date()
            }

            newCount += 1
        }

        if newCount > 0 {
            do {
                try modelContext.save()
                messagesProcessed += newCount
                logger.info("Synced \(newCount) new iMessage interaction(s)")
            } catch {
                syncError = "Failed to save: \(error.localizedDescription)"
                logger.error("Save failed: \(error)")
                return
            }
        }

        lastProcessedROWID = highestROWID
        lastSyncDate = Date()
        syncError = nil
    }

    // MARK: - Phone Normalization

    /// Builds a dictionary mapping normalized phone numbers (last 10 digits) to contacts.
    private func buildPhoneLookup(contacts: [Contact]) -> [String: Contact] {
        var lookup: [String: Contact] = [:]
        for contact in contacts {
            for phone in contact.phones {
                let normalized = normalizePhoneNumber(phone)
                if !normalized.isEmpty {
                    lookup[normalized] = contact
                }
            }
        }
        return lookup
    }

    /// Strips a phone string to its last 10 digits for comparison.
    /// Handles formats like +1 (555) 867-5309, 15558675309, etc.
    private func normalizePhoneNumber(_ raw: String) -> String {
        let digits = raw.filter(\.isWholeNumber)
        if digits.count >= 10 {
            return String(digits.suffix(10))
        }
        return digits
    }

    // MARK: - Date Conversion

    /// Converts an iMessage timestamp to a Swift Date.
    /// Modern macOS stores dates as nanoseconds since 2001-01-01.
    /// Older databases used seconds. We detect by magnitude.
    private func dateFromIMesssageTimestamp(_ timestamp: Int64) -> Date {
        let reference = Date(timeIntervalSinceReferenceDate: 0) // 2001-01-01

        if timestamp > 1_000_000_000 {
            // Nanoseconds since 2001-01-01
            let seconds = TimeInterval(timestamp) / 1_000_000_000
            return reference.addingTimeInterval(seconds)
        } else {
            // Seconds since 2001-01-01 (older format)
            return reference.addingTimeInterval(TimeInterval(timestamp))
        }
    }
}
#endif
