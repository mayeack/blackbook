import Foundation

/// A fully received HTTP/1.1 request.
struct LoopbackRequest {
    let method: String
    let path: String
    let query: [String: String]
    /// Header names are lowercased.
    let headers: [String: String]
    let body: Data

    func header(_ name: String) -> String? { headers[name.lowercased()] }
}

struct LoopbackResponse {
    var status: Int
    var headers: [(String, String)]
    var body: Data

    init(status: Int, headers: [(String, String)] = [], body: Data = Data()) {
        self.status = status
        self.headers = headers
        self.body = body
    }

    static func json(_ status: Int, _ value: JSON, headers: [(String, String)] = []) -> LoopbackResponse {
        LoopbackResponse(status: status,
                         headers: [("Content-Type", "application/json; charset=utf-8")] + headers,
                         body: value.serialized())
    }

    /// Serialized response. Every response closes the connection (one request per connection).
    func encoded() -> Data {
        var head = "HTTP/1.1 \(status) \(HTTPStatus.text(status))\r\n"
        for (k, v) in headers where !k.isEmpty {
            head += "\(k): \(v)\r\n"
        }
        head += "Content-Length: \(body.count)\r\n"
        head += "Cache-Control: no-store\r\n"
        head += "X-Content-Type-Options: nosniff\r\n"
        head += "Connection: close\r\n\r\n"
        var data = Data(head.utf8)
        data.append(body)
        return data
    }
}

enum HTTPStatus {
    static func text(_ code: Int) -> String {
        switch code {
        case 200: return "OK"
        case 201: return "Created"
        case 202: return "Accepted"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 408: return "Request Timeout"
        case 409: return "Conflict"
        case 411: return "Length Required"
        case 413: return "Payload Too Large"
        case 415: return "Unsupported Media Type"
        case 422: return "Unprocessable Content"
        case 429: return "Too Many Requests"
        case 431: return "Request Header Fields Too Large"
        case 500: return "Internal Server Error"
        case 501: return "Not Implemented"
        case 503: return "Service Unavailable"
        case 505: return "HTTP Version Not Supported"
        default: return "Status \(code)"
        }
    }
}

struct HTTPLimits {
    var maxHeaderBytes = 64 * 1024
    var maxBodyBytes = 1 << 20
    var idleTimeout: TimeInterval = 30
    var maxConcurrentConnections = 32
}

enum HTTPParseResult {
    case needMore
    case complete(LoopbackRequest)
    case failure(status: Int, code: String, message: String)
}

/// Stateless parser over the bytes received so far. Strict on purpose: no chunked bodies,
/// Content-Length required when a body is allowed, no duplicate Host/Content-Length.
enum HTTPRequestParser {
    private static let crlfcrlf = Data([0x0D, 0x0A, 0x0D, 0x0A])
    private static let bodyMethods: Set<String> = ["POST", "PUT", "PATCH"]

    static func parse(_ buffer: Data, limits: HTTPLimits) -> HTTPParseResult {
        guard let end = buffer.range(of: crlfcrlf) else {
            if buffer.count > limits.maxHeaderBytes {
                return .failure(status: 431, code: "headers_too_large", message: "header section exceeds limit")
            }
            return .needMore
        }
        let headerLength = end.lowerBound - buffer.startIndex
        if headerLength > limits.maxHeaderBytes {
            return .failure(status: 431, code: "headers_too_large", message: "header section exceeds limit")
        }
        guard let head = String(data: buffer[buffer.startIndex..<end.lowerBound], encoding: .utf8) else {
            return bad("header section is not UTF-8")
        }
        var lines = head.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return bad("empty request") }
        let requestLine = lines.removeFirst()
        let parts = requestLine.split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return bad("malformed request line") }
        let method = String(parts[0])
        let target = String(parts[1])
        let version = String(parts[2])
        guard !method.isEmpty, method.allSatisfy({ $0.isASCII && $0.isUppercase }) else { return bad("bad method") }
        guard version == "HTTP/1.1" || version == "HTTP/1.0" else {
            return .failure(status: 505, code: "bad_request", message: "unsupported HTTP version")
        }
        guard target.hasPrefix("/") else { return bad("request target must be origin-form") }

        var headers: [String: String] = [:]
        for line in lines {
            if line.isEmpty { continue }
            if line.first == " " || line.first == "\t" { return bad("obsolete header folding") }
            guard let colon = line.firstIndex(of: ":") else { return bad("malformed header") }
            let name = line[..<colon].lowercased()
            guard !name.isEmpty, !name.contains(" ") else { return bad("malformed header name") }
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if let existing = headers[name] {
                if name == "host" || name == "content-length" || name == "authorization" {
                    return bad("duplicate \(name) header")
                }
                headers[name] = existing + ", " + value
            } else {
                headers[name] = value
            }
        }

        if headers["transfer-encoding"] != nil {
            return .failure(status: 501, code: "not_implemented", message: "transfer-encoding not supported")
        }
        var contentLength = 0
        if let raw = headers["content-length"] {
            guard !raw.isEmpty, raw.count <= 10, raw.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(raw) else {
                return bad("invalid Content-Length")
            }
            contentLength = n
        } else if bodyMethods.contains(method) {
            return .failure(status: 411, code: "length_required", message: "Content-Length required")
        }
        if contentLength > limits.maxBodyBytes {
            return .failure(status: 413, code: "payload_too_large", message: "body exceeds 1 MiB")
        }

        let bodyStart = end.upperBound
        let available = buffer.endIndex - bodyStart
        if available < contentLength { return .needMore }
        let body = Data(buffer[bodyStart..<(bodyStart + contentLength)])

        let (path, query) = splitTarget(target)
        return .complete(LoopbackRequest(method: method, path: path, query: query, headers: headers, body: body))
    }

    static func splitTarget(_ target: String) -> (String, [String: String]) {
        let pieces = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = String(pieces[0])
        var query: [String: String] = [:]
        if pieces.count > 1 {
            for pair in pieces[1].split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                let key = decodeComponent(String(kv[0]))
                let value = kv.count > 1 ? decodeComponent(String(kv[1])) : ""
                if !key.isEmpty, query[key] == nil { query[key] = value }
            }
        }
        return (path, query)
    }

    private static func decodeComponent(_ s: String) -> String {
        let spaced = s.replacingOccurrences(of: "+", with: " ")
        return spaced.removingPercentEncoding ?? spaced
    }

    private static func bad(_ message: String) -> HTTPParseResult {
        .failure(status: 400, code: "bad_request", message: message)
    }
}
