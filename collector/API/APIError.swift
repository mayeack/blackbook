import Foundation

/// Collector v1 error envelope: `{"error":{"code","message"}}`.
struct APIError: Error, Equatable {
    let status: Int
    let code: String
    let message: String

    static func badRequest(_ message: String) -> APIError { APIError(status: 400, code: "bad_request", message: message) }
    static let unauthorized = APIError(status: 401, code: "unauthorized", message: "missing or invalid bearer token")
    static let forbiddenOrigin = APIError(status: 403, code: "forbidden_origin", message: "browser-originated requests are not accepted")
    static let badHost = APIError(status: 403, code: "bad_host", message: "Host must be 127.0.0.1 or localhost on the collector port")
    static let notFound = APIError(status: 404, code: "not_found", message: "no such route")
    static let methodNotAllowed = APIError(status: 405, code: "method_not_allowed", message: "method not allowed for this route")

    // Domain codes from architecture.md §1a.
    static let fdaMissing = APIError(status: 503, code: "fda_missing", message: "Full Disk Access is not granted to the collector")
    static func chatdbUnavailable(_ detail: String) -> APIError { APIError(status: 503, code: "chatdb_unavailable", message: detail) }
    static func contactsDenied(_ detail: String) -> APIError { APIError(status: 403, code: "contacts_denied", message: detail) }
    static let recipientNotAllowed = APIError(status: 403, code: "recipient_not_allowed", message: "recipient is not one of the owner's own handles")
    static let whatsappNotInstalled = APIError(status: 404, code: "whatsapp_not_installed", message: "WhatsApp for Mac data not found")
    static func snapshotInconsistent(_ detail: String) -> APIError { APIError(status: 503, code: "snapshot_inconsistent", message: detail) }
    static let attachmentNotFound = APIError(status: 404, code: "attachment_not_found", message: "no such attachment")
    static func attachmentNotAllowed(_ detail: String) -> APIError { APIError(status: 403, code: "attachment_not_allowed", message: detail) }
    static let attachmentUnreadable = APIError(status: 422, code: "attachment_unreadable", message: "the attachment is not a decodable image")
    static func callHistoryUnavailable(status: Int, _ detail: String) -> APIError {
        APIError(status: status, code: "callhistory_unavailable", message: detail)
    }
    static func internalError(_ detail: String) -> APIError { APIError(status: 500, code: "internal", message: detail) }

    var response: LoopbackResponse {
        APIErrorBody.response(status: status, code: code, message: message)
    }

    static func from(_ error: ChatDBError) -> APIError {
        switch error {
        case .accessDenied: return .fdaMissing
        case .notFound: return .chatdbUnavailable("chat.db not found")
        case let .unavailable(detail): return .chatdbUnavailable(detail)
        }
    }

    static func from(callHistory error: CallHistoryError) -> APIError {
        switch error {
        case .accessDenied: return .fdaMissing
        case .notFound: return .callHistoryUnavailable(status: 404, "call history not found")
        case let .unavailable(detail): return .callHistoryUnavailable(status: 503, detail)
        }
    }
}

enum APIErrorBody {
    static func json(code: String, message: String) -> JSON {
        .object([("error", .object([("code", .string(code)), ("message", .string(message))]))])
    }

    static func response(status: Int, code: String, message: String) -> LoopbackResponse {
        var headers: [(String, String)] = []
        if status == 401 { headers.append(("WWW-Authenticate", "Bearer")) }
        return .json(status, json(code: code, message: message), headers: headers)
    }
}
