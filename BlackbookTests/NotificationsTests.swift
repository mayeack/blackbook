import XCTest
import SwiftData
@testable import Blackbook

/// Tests for the notifications subsystem: `NotificationService` generation/dedup and the
/// `AppNotification` sync round-trip + conflict resolution (mirrors `SyncApplyTests`).
@MainActor
final class NotificationsTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!

    override func setUpWithError() throws {
        container = try TestHelpers.makeContainer()
        context = ModelContext(container)
    }

    override func tearDown() {
        context = nil
        container = nil
    }

    // MARK: - Fading generation

    func testGeneratesFadingForCoolingContactsOnly() throws {
        TestHelpers.makeContact(firstName: "Cooling", lastName: "A", score: 15, in: context)   // 0 < 15 < 30 → yes
        TestHelpers.makeContact(firstName: "Dormant", lastName: "B", score: 0, in: context)     // score 0 → no
        TestHelpers.makeContact(firstName: "Healthy", lastName: "C", score: 80, in: context)    // >= 30 → no
        TestHelpers.makeContact(firstName: "Hidden", lastName: "D", score: 12, isHidden: true, in: context) // hidden → no
        try context.save()

        let created = NotificationService.generateFadingNotifications(context: context)
        XCTAssertEqual(created, 1)

        let notifs = try context.fetch(FetchDescriptor<AppNotification>())
        XCTAssertEqual(notifs.count, 1)
        XCTAssertEqual(notifs.first?.kind, .fadingRelationship)
        XCTAssertEqual(notifs.first?.title.contains("Cooling"), true)
    }

    func testFadingGenerationIsIdempotent() throws {
        TestHelpers.makeContact(firstName: "Cooling", lastName: "A", score: 15, in: context)
        try context.save()

        XCTAssertEqual(NotificationService.generateFadingNotifications(context: context), 1)
        XCTAssertEqual(NotificationService.generateFadingNotifications(context: context), 0, "must not recreate an existing notification")
        XCTAssertEqual(try context.fetch(FetchDescriptor<AppNotification>()).count, 1)
    }

    func testDismissedFadingNotificationIsNotRecreated() throws {
        let c = TestHelpers.makeContact(firstName: "Cooling", lastName: "A", score: 15, in: context)
        try context.save()
        XCTAssertEqual(NotificationService.generateFadingNotifications(context: context), 1)

        let notif = try XCTUnwrap(try context.fetch(FetchDescriptor<AppNotification>()).first)
        XCTAssertEqual(notif.contactId, c.id)
        notif.isDismissed = true
        try context.save()

        XCTAssertEqual(NotificationService.generateFadingNotifications(context: context), 0, "dismissed suggestion stays dismissed")
    }

    // MARK: - Archive suggestion

    func testSuggestArchiveCreatesOnceThenDedups() throws {
        let id = UUID()
        XCTAssertTrue(NotificationService.suggestArchive(contactId: id, displayName: "Gone Person", context: context))
        try context.save()
        XCTAssertFalse(NotificationService.suggestArchive(contactId: id, displayName: "Gone Person", context: context))

        let notifs = try context.fetch(FetchDescriptor<AppNotification>())
        XCTAssertEqual(notifs.count, 1)
        XCTAssertEqual(notifs.first?.kind, .archiveSuggestion)
    }

    // MARK: - Sync round-trip

    func testAppNotificationRoundTrips() throws {
        let contactId = UUID()
        let original = AppNotification(kind: .archiveSuggestion, title: "Archive Bob?", message: "Gone", contactId: contactId)
        context.insert(original)
        try context.save()

        let dict = ModelSyncApply.appNotificationToDict(original)

        // Apply into a fresh store to prove the payload reconstructs the record from scratch.
        let freshContainer = try TestHelpers.makeContainer()
        let other = ModelContext(freshContainer)
        try ModelSyncApply.applyRemoteAppNotification(dict, to: other)
        try other.save()

        let fetched = try XCTUnwrap(try other.fetch(FetchDescriptor<AppNotification>()).first { $0.id == original.id })
        XCTAssertEqual(fetched.kind, .archiveSuggestion)
        XCTAssertEqual(fetched.title, "Archive Bob?")
        XCTAssertEqual(fetched.contactId, contactId)
        XCTAssertEqual(fetched.syncStatus, SyncStatus.synced.rawValue)
    }

    func testApplyRemoteRespectsConflictResolution() throws {
        let n = AppNotification(kind: .fadingRelationship, title: "Local", message: "local")
        context.insert(n)
        n.markLocallyEdited() // newer + pending → protected from an older remote
        try context.save()

        // Older remote payload for the same id should be ignored while local is pending.
        var olderDict = ModelSyncApply.appNotificationToDict(n)
        olderDict["title"] = "Stale Remote"
        let iso = ISO8601DateFormatter()
        olderDict["updatedAt"] = iso.string(from: n.updatedAt.addingTimeInterval(-3600))
        try ModelSyncApply.applyRemoteAppNotification(olderDict, to: context)
        XCTAssertEqual(n.title, "Local", "older remote must not clobber a newer pending local record")

        // A newer remote payload wins.
        var newerDict = ModelSyncApply.appNotificationToDict(n)
        newerDict["title"] = "Fresh Remote"
        newerDict["updatedAt"] = iso.string(from: n.updatedAt.addingTimeInterval(3600))
        try ModelSyncApply.applyRemoteAppNotification(newerDict, to: context)
        XCTAssertEqual(n.title, "Fresh Remote", "newer remote should win")
    }
}
