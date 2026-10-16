import Foundation

/// ISO-8601 wire format for every timestamp the collector emits or accepts:
/// UTC with milliseconds, e.g. `2026-10-14T07:30:00.000Z`.
enum ISOTime {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let lock = NSLock()

    static func format(_ date: Date) -> String {
        lock.lock(); defer { lock.unlock() }
        return withFraction.string(from: date)
    }

    /// Accepts RFC 3339 timestamps with or without fractional seconds and any UTC offset.
    static func parse(_ text: String) -> Date? {
        lock.lock(); defer { lock.unlock() }
        return withFraction.date(from: text) ?? plain.date(from: text)
    }
}

/// chat.db time math (ported from BlackbookServer/App/IMessageSyncService.swift:399-411).
enum AppleTime {
    /// Modern chat.db stores nanoseconds since 2001-01-01; very old rows used seconds.
    static func date(fromChatDB value: Int64) -> Date? {
        guard value != 0 else { return nil }
        let reference = Date(timeIntervalSinceReferenceDate: 0)
        if value > 1_000_000_000 || value < -1_000_000_000 {
            return reference.addingTimeInterval(TimeInterval(value) / 1_000_000_000)
        }
        return reference.addingTimeInterval(TimeInterval(value))
    }

    /// Inverse of `date(fromChatDB:)` in the nanosecond form used by modern chat.db.
    static func chatDBValue(from date: Date) -> Int64 {
        Int64((date.timeIntervalSinceReferenceDate * 1_000_000_000).rounded())
    }
}

/// Injectable time source so the send verifier's polling loop is testable.
protocol CollectorClock: AnyObject {
    func now() -> Date
    func sleep(_ seconds: TimeInterval)
}

final class SystemClock: CollectorClock {
    func now() -> Date { Date() }
    func sleep(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }
}
