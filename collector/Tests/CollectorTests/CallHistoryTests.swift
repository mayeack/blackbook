import Foundation
import Testing
#if canImport(CollectorCore)
@testable import CollectorCore
#endif

/// A synthetic CallHistory.storedata: the columns the reader uses from the real Core Data store (macOS 26/27),
/// with the participants join table numbered as given.
enum SyntheticCallHistory {
    struct Call {
        var pk: Int64
        var uid: String
        var at: Date?
        var duration: Double = 0
        var type: Int64 = 1
        var provider = "com.apple.Telephony"
        var originated = false
        var answered = true
        var address: String?
        var participants: [String] = []
    }

    static func write(_ calls: [Call], to path: String, joinEntity: (call: Int, handle: Int) = (2, 4)) throws {
        try? FileManager.default.removeItem(atPath: path)
        let conn = try SQLiteConnection(path: path, mode: .readWriteCreate)
        defer { conn.close() }
        let join = "Z_\(joinEntity.call)REMOTEPARTICIPANTHANDLES"
        let callCol = "Z_\(joinEntity.call)REMOTEPARTICIPANTCALLS"
        let handleCol = "Z_\(joinEntity.handle)REMOTEPARTICIPANTHANDLES"
        try conn.execute("""
            CREATE TABLE ZCALLRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZANSWERED INTEGER,
              ZCALLTYPE INTEGER, ZORIGINATED INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT, ZADDRESS VARCHAR,
              ZSERVICE_PROVIDER VARCHAR, ZUNIQUE_ID VARCHAR);
            CREATE TABLE ZHANDLE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZTYPE INTEGER,
              ZNORMALIZEDVALUE VARCHAR, ZVALUE VARCHAR);
            CREATE TABLE \(join) (\(callCol) INTEGER, \(handleCol) INTEGER, PRIMARY KEY (\(callCol), \(handleCol)));
            """)
        var handlePK: Int64 = 0
        for c in calls {
            try conn.run("""
                INSERT INTO ZCALLRECORD (Z_PK, ZANSWERED, ZCALLTYPE, ZORIGINATED, ZDATE, ZDURATION, ZADDRESS, ZSERVICE_PROVIDER, ZUNIQUE_ID)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, [.int(c.pk), .int(c.answered ? 1 : 0), .int(c.type), .int(c.originated ? 1 : 0),
                      // Bound as text; the TIMESTAMP/FLOAT column affinity stores them as REAL, as Core Data does.
                      c.at.map { .text(String($0.timeIntervalSinceReferenceDate)) } ?? .null, .text(String(c.duration)),
                      c.address.map(SQLiteValue.text) ?? .null, .text(c.provider), .text(c.uid)])
            for p in c.participants {
                handlePK += 1
                try conn.run("INSERT INTO ZHANDLE (Z_PK, ZTYPE, ZVALUE) VALUES (?, 2, ?)", [.int(handlePK), .text(p)])
                try conn.run("INSERT INTO \(join) VALUES (?, ?)", [.int(c.pk), .int(handlePK)])
            }
        }
    }

    static let sample: [Call] = [
        Call(pk: 1, uid: "CALL-0001", at: refDate.addingTimeInterval(-7200), address: "+15555550101"),
        Call(pk: 2, uid: "CALL-0002", at: refDate.addingTimeInterval(-3600), duration: 125.5, type: 8,
             provider: "com.apple.FaceTime", originated: true, address: "friend@example.com"),
        Call(pk: 3, uid: "CALL-0003", at: nil, answered: false, address: "+15555550104"),
        Call(pk: 4, uid: "CALL-0004", at: refDate.addingTimeInterval(-60), type: 16, provider: "com.apple.FaceTime",
             address: "+15555550102", participants: ["+15555550103", "+15555550102"]),
        Call(pk: 5, uid: "CALL-0005", at: refDate, answered: false, address: "+15555550101"),
    ]
}

@Suite("call history")
struct CallHistoryTests {
    private static func items(_ r: CollectorAPI.Reply) -> [JSON] {
        guard case let .array(items)? = r.body["items"] else { return [] }
        return items
    }

    @Test func pagesCallsOldestFirstWithParticipants() throws {
        let h = try APIHarness()
        try SyntheticCallHistory.write(SyntheticCallHistory.sample, to: h.callHistoryPath)

        let all = h.reply("/v1/calls?after_rowid=0")
        #expect(all.status == 200)
        let items = Self.items(all)
        // The call with no time is skipped; the cursor still moves past it.
        #expect(items.compactMap { $0["unique_id"] } == ["CALL-0001", "CALL-0002", "CALL-0004", "CALL-0005"].map(JSON.string))
        #expect(all.body["max_rowid"] == .int(5))
        #expect(all.body["has_more"] == .bool(false))
        #expect(items[1]["duration_s"] == .double(125.5))
        #expect(items[1]["call_type"] == .int(8))
        #expect(items[1]["originated"] == .bool(true))
        #expect(items[1]["date"] == .iso(refDate.addingTimeInterval(-3600)))
        // ZADDRESS first, then the other participants, once each.
        #expect(items[2]["handles"] == .array([.string("+15555550102"), .string("+15555550103")]))
        #expect(items[3]["answered"] == .bool(false))

        let first = h.reply("/v1/calls?after_rowid=0&limit=2")
        #expect(Self.items(first).count == 2)
        #expect(first.body["has_more"] == .bool(true))
        #expect(first.body["next_after_rowid"] == .int(2))
        let next = h.reply("/v1/calls?after_rowid=2&limit=2")
        #expect(Self.items(next).compactMap { $0["rowid"] } == [JSON.int(4)])
        #expect(next.body["next_after_rowid"] == .int(4))
        #expect(next.body["has_more"] == .bool(true))
        let rest = h.reply("/v1/calls?after_rowid=4&limit=2")
        #expect(Self.items(rest).compactMap { $0["rowid"] } == [JSON.int(5)])
        #expect(rest.body["has_more"] == .bool(false))

        #expect(try checkGolden("calls", all.body))
    }

    @Test func findsTheParticipantsJoinWhateverItsEntityNumbers() throws {
        let h = try APIHarness()
        try SyntheticCallHistory.write(SyntheticCallHistory.sample, to: h.callHistoryPath, joinEntity: (3, 5))
        let items = Self.items(h.reply("/v1/calls?after_rowid=3"))
        #expect(items.first?["handles"] == .array([.string("+15555550102"), .string("+15555550103")]))
    }

    @Test func missingStoreAndBadParams() throws {
        let h = try APIHarness()
        let missing = h.request("/v1/calls?after_rowid=0")
        #expect(missing.status == 404)
        #expect(APIHarness.errorCode(missing) == "callhistory_unavailable")

        try SyntheticCallHistory.write(SyntheticCallHistory.sample, to: h.callHistoryPath)
        #expect(h.request("/v1/calls?after_rowid=-1").status == 400)
        #expect(h.request("/v1/calls?limit=1001").status == 400)
        #expect(h.request("POST", "/v1/calls").status == 405)
    }

    @Test func unknownLayoutIsUnavailable() throws {
        let h = try APIHarness()
        let conn = try SQLiteConnection(path: h.callHistoryPath, mode: .readWriteCreate)
        try conn.execute("CREATE TABLE ZCALLRECORD (Z_PK INTEGER PRIMARY KEY, ZWHEN REAL)")
        conn.close()
        let r = h.request("/v1/calls")
        #expect(r.status == 503)
        #expect(APIHarness.errorCode(r) == "callhistory_unavailable")
    }
}
