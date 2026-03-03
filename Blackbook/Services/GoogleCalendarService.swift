import Foundation
import AuthenticationServices
import CryptoKit
import Observation
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "GoogleCalendar")

// MARK: - API Response Types

struct GoogleCalendarListResponse: Decodable {
    let items: [GoogleCalendar]?
}

struct GoogleCalendar: Decodable, Identifiable {
    let id: String
    let summary: String
    let backgroundColor: String?
    let primary: Bool?
    let accessRole: String?
}

struct GoogleEventsResponse: Decodable {
    let items: [GoogleCalendarEvent]?
    let nextPageToken: String?
}

struct GoogleCalendarEvent: Decodable, Identifiable {
    let id: String
    let summary: String?
    let description: String?
    let start: GoogleEventDateTime?
    let end: GoogleEventDateTime?
    let status: String?

    var resolvedStartDate: Date? {
        start?.resolvedDate
    }

    var resolvedEndDate: Date? {
        end?.resolvedDate
    }
}

struct GoogleEventDateTime: Decodable {
    let dateTime: String?
    let date: String?

    var resolvedDate: Date? {
        if let dateTime {
            return ISO8601DateFormatter().date(from: dateTime)
                ?? parseFlexibleISO8601(dateTime)
        }
        if let date {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            formatter.locale = Locale(identifier: "en_US_POSIX")
            return formatter.date(from: date)
        }
        return nil
    }

    private func parseFlexibleISO8601(_ string: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: string)
    }
}

// MARK: - Suggested Event (view-layer type)

struct SuggestedCalendarEvent: Identifiable {
    let id: String
    let title: String
    let startDate: Date
    let endDate: Date?
    let eventDescription: String?
    let calendarName: String
    let calendarColorHex: String?
}

// MARK: - Service

@Observable
final class GoogleCalendarService {
    var isLoading = false
    var isSignedIn = false
    var lastError: String?
    var suggestedEvents: [SuggestedCalendarEvent] = []
    var availableCalendars: [GoogleCalendar] = []

    private var codeVerifier: String?
    private var authSession: ASWebAuthenticationSession?
    private var authPresentationProvider: PresentationContextProvider?

    // MARK: - Computed

    var clientId: String? {
        KeychainService.retrieve(
            service: AppConstants.GoogleCalendar.keychainServiceName,
            account: AppConstants.GoogleCalendar.clientIdAccount
        )
    }

    var isConfigured: Bool { clientId != nil }

    private func reversedClientIdScheme(for clientId: String) -> String {
        clientId.split(separator: ".").reversed().joined(separator: ".")
    }

    private var accessToken: String? {
        KeychainService.retrieve(
            service: AppConstants.GoogleCalendar.keychainServiceName,
            account: AppConstants.GoogleCalendar.accessTokenAccount
        )
    }

    private var refreshToken: String? {
        KeychainService.retrieve(
            service: AppConstants.GoogleCalendar.keychainServiceName,
            account: AppConstants.GoogleCalendar.refreshTokenAccount
        )
    }

    private var tokenExpiry: Date? {
        guard let str = KeychainService.retrieve(
            service: AppConstants.GoogleCalendar.keychainServiceName,
            account: AppConstants.GoogleCalendar.tokenExpiryAccount
        ) else { return nil }
        return ISO8601DateFormatter().date(from: str)
    }

    private var isTokenExpired: Bool {
        guard let expiry = tokenExpiry else { return true }
        return Date() >= expiry
    }

    var selectedCalendarIds: Set<String> {
        get {
            let arr = UserDefaults.standard.stringArray(
                forKey: AppConstants.GoogleCalendar.selectedCalendarsKey
            ) ?? []
            return Set(arr)
        }
        set {
            UserDefaults.standard.set(
                Array(newValue),
                forKey: AppConstants.GoogleCalendar.selectedCalendarsKey
            )
        }
    }

    private var lastSyncDate: Date? {
        get { UserDefaults.standard.object(forKey: AppConstants.GoogleCalendar.lastSyncKey) as? Date }
        set { UserDefaults.standard.set(newValue, forKey: AppConstants.GoogleCalendar.lastSyncKey) }
    }

    // MARK: - Init

    init() {
        isSignedIn = refreshToken != nil
    }

    // MARK: - Client ID Management

    @discardableResult
    func saveClientId(_ clientId: String) -> Bool {
        KeychainService.save(
            clientId,
            service: AppConstants.GoogleCalendar.keychainServiceName,
            account: AppConstants.GoogleCalendar.clientIdAccount
        )
    }

    func deleteClientId() {
        signOut()
        KeychainService.delete(
            service: AppConstants.GoogleCalendar.keychainServiceName,
            account: AppConstants.GoogleCalendar.clientIdAccount
        )
    }

    // MARK: - OAuth PKCE

    @MainActor
    func signIn() async {
        guard let clientId else {
            lastError = "Google Client ID not configured"
            return
        }

        let verifier = generateCodeVerifier()
        codeVerifier = verifier

        guard let challenge = generateCodeChallenge(from: verifier) else {
            lastError = "Failed to generate PKCE challenge"
            return
        }

        let redirectScheme = reversedClientIdScheme(for: clientId)
        let redirectURI = "\(redirectScheme):/oauthredirect"
        var components = URLComponents(string: AppConstants.GoogleCalendar.authURL)!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: AppConstants.GoogleCalendar.calendarScope),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "access_type", value: "offline"),
            URLQueryItem(name: "prompt", value: "consent"),
        ]

        guard let authURL = components.url else {
            lastError = "Failed to build auth URL"
            return
        }

        do {
            let callbackURL = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
                let session = ASWebAuthenticationSession(
                    url: authURL,
                    callbackURLScheme: redirectScheme
                ) { [weak self] callbackURL, error in
                    self?.authSession = nil
                    self?.authPresentationProvider = nil
                    if let error {
                        continuation.resume(throwing: error)
                    } else if let callbackURL {
                        continuation.resume(returning: callbackURL)
                    } else {
                        continuation.resume(throwing: URLError(.badServerResponse))
                    }
                }
                session.prefersEphemeralWebBrowserSession = true
                let provider = PresentationContextProvider()
                self.authPresentationProvider = provider
                session.presentationContextProvider = provider
                self.authSession = session
                session.start()
            }

            guard let code = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "code" })?.value else {
                lastError = "No authorization code received"
                return
            }

            await exchangeCodeForTokens(code: code, clientId: clientId, redirectURI: redirectURI, verifier: verifier)
        } catch {
            if (error as NSError).code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                logger.info("User cancelled sign-in")
            } else {
                lastError = "Sign-in failed: \(error.localizedDescription)"
                logger.error("OAuth error: \(error.localizedDescription)")
            }
        }
    }

    func signOut() {
        let service = AppConstants.GoogleCalendar.keychainServiceName
        KeychainService.delete(service: service, account: AppConstants.GoogleCalendar.accessTokenAccount)
        KeychainService.delete(service: service, account: AppConstants.GoogleCalendar.refreshTokenAccount)
        KeychainService.delete(service: service, account: AppConstants.GoogleCalendar.tokenExpiryAccount)
        UserDefaults.standard.removeObject(forKey: AppConstants.GoogleCalendar.selectedCalendarsKey)
        UserDefaults.standard.removeObject(forKey: AppConstants.GoogleCalendar.lastSyncKey)
        isSignedIn = false
        suggestedEvents = []
        availableCalendars = []
        logger.info("Signed out of Google Calendar")
    }

    // MARK: - Token Exchange & Refresh

    private func exchangeCodeForTokens(code: String, clientId: String, redirectURI: String, verifier: String) async {
        let body: [String: String] = [
            "code": code,
            "client_id": clientId,
            "redirect_uri": redirectURI,
            "grant_type": "authorization_code",
            "code_verifier": verifier,
        ]
        await performTokenRequest(body: body)
    }

    private func refreshAccessToken() async -> Bool {
        guard let clientId, let refreshToken else { return false }
        let body: [String: String] = [
            "client_id": clientId,
            "refresh_token": refreshToken,
            "grant_type": "refresh_token",
        ]
        await performTokenRequest(body: body)
        return accessToken != nil && !isTokenExpired
    }

    private func performTokenRequest(body: [String: String]) async {
        guard let url = URL(string: AppConstants.GoogleCalendar.tokenURL) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30

        let encoded = body.map { key, value in
            "\(key.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? key)=\(value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value)"
        }.joined(separator: "&")
        request.httpBody = encoded.data(using: .utf8)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let responseBody = String(data: data, encoding: .utf8) ?? "unknown"
                logger.error("Token request failed: \(responseBody)")
                lastError = "Token request failed"
                return
            }

            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

            let service = AppConstants.GoogleCalendar.keychainServiceName

            if let token = json["access_token"] as? String {
                KeychainService.save(token, service: service, account: AppConstants.GoogleCalendar.accessTokenAccount)
            }

            if let refresh = json["refresh_token"] as? String {
                KeychainService.save(refresh, service: service, account: AppConstants.GoogleCalendar.refreshTokenAccount)
            }

            if let expiresIn = json["expires_in"] as? Int {
                let expiry = Date().addingTimeInterval(TimeInterval(expiresIn - 60))
                let expiryStr = ISO8601DateFormatter().string(from: expiry)
                KeychainService.save(expiryStr, service: service, account: AppConstants.GoogleCalendar.tokenExpiryAccount)
            }

            isSignedIn = true
            lastError = nil
            logger.info("Tokens saved successfully")
        } catch {
            lastError = "Network error: \(error.localizedDescription)"
            logger.error("Token request error: \(error.localizedDescription)")
        }
    }

    // MARK: - Authorized Request Helper

    private func authorizedRequest(for url: URL) async -> URLRequest? {
        if isTokenExpired {
            let refreshed = await refreshAccessToken()
            if !refreshed {
                lastError = "Session expired. Please sign in again."
                isSignedIn = false
                return nil
            }
        }

        guard let token = accessToken else {
            lastError = "No access token"
            return nil
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 30
        return request
    }

    // MARK: - Calendar List

    func fetchCalendarList() async {
        guard let url = URL(string: AppConstants.GoogleCalendar.calendarListURL) else { return }
        guard let request = await authorizedRequest(for: url) else { return }

        isLoading = true
        defer { isLoading = false }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                lastError = "Failed to fetch calendars"
                return
            }
            let decoded = try JSONDecoder().decode(GoogleCalendarListResponse.self, from: data)
            availableCalendars = decoded.items ?? []
            lastError = nil
        } catch {
            lastError = "Error loading calendars: \(error.localizedDescription)"
            logger.error("Calendar list error: \(error.localizedDescription)")
        }
    }

    // MARK: - Event Fetching

    func fetchEvents(rejectedEventIds: Set<String>, force: Bool = false) async {
        guard isSignedIn else { return }

        if !force, !suggestedEvents.isEmpty, let lastSync = lastSyncDate {
            let hoursSinceSync = Date().timeIntervalSince(lastSync) / 3600
            if hoursSinceSync < Double(AppConstants.GoogleCalendar.syncIntervalHours) {
                return
            }
        }

        let calendarIds = selectedCalendarIds
        guard !calendarIds.isEmpty else {
            suggestedEvents = []
            return
        }

        isLoading = true
        lastError = nil
        defer { isLoading = false }

        let now = Date()
        let lookback = Calendar.current.date(
            byAdding: .day,
            value: -AppConstants.GoogleCalendar.eventLookbackDays,
            to: now
        )!

        let isoFormatter = ISO8601DateFormatter()
        let timeMin = isoFormatter.string(from: lookback)
        let timeMax = isoFormatter.string(from: now)

        var allEvents: [SuggestedCalendarEvent] = []

        for calendarId in calendarIds {
            let calendarName = availableCalendars.first(where: { $0.id == calendarId })?.summary ?? calendarId
            let colorHex = availableCalendars.first(where: { $0.id == calendarId })?.backgroundColor

            let events = await fetchEventsForCalendar(
                calendarId: calendarId,
                timeMin: timeMin,
                timeMax: timeMax,
                calendarName: calendarName,
                calendarColorHex: colorHex
            )
            allEvents.append(contentsOf: events)
        }

        suggestedEvents = allEvents
            .filter { !rejectedEventIds.contains($0.id) }
            .sorted { $0.startDate > $1.startDate }

        lastSyncDate = now
        logger.info("Fetched \(allEvents.count) events, \(self.suggestedEvents.count) after filtering")
    }

    private func fetchEventsForCalendar(
        calendarId: String,
        timeMin: String,
        timeMax: String,
        calendarName: String,
        calendarColorHex: String?
    ) async -> [SuggestedCalendarEvent] {
        let encodedId = calendarId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? calendarId
        let baseURL = "https://www.googleapis.com/calendar/v3/calendars/\(encodedId)/events"

        var components = URLComponents(string: baseURL)!
        components.queryItems = [
            URLQueryItem(name: "timeMin", value: timeMin),
            URLQueryItem(name: "timeMax", value: timeMax),
            URLQueryItem(name: "singleEvents", value: "true"),
            URLQueryItem(name: "orderBy", value: "startTime"),
            URLQueryItem(name: "maxResults", value: "250"),
        ]

        guard let url = components.url,
              let request = await authorizedRequest(for: url) else { return [] }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return [] }
            let decoded = try JSONDecoder().decode(GoogleEventsResponse.self, from: data)

            return (decoded.items ?? []).compactMap { event -> SuggestedCalendarEvent? in
                guard event.status != "cancelled",
                      let title = event.summary, !title.isEmpty,
                      let startDate = event.resolvedStartDate else { return nil }

                return SuggestedCalendarEvent(
                    id: event.id,
                    title: title,
                    startDate: startDate,
                    endDate: event.resolvedEndDate,
                    eventDescription: event.description,
                    calendarName: calendarName,
                    calendarColorHex: calendarColorHex
                )
            }
        } catch {
            logger.error("Event fetch error for \(calendarId): \(error.localizedDescription)")
            return []
        }
    }

    // MARK: - PKCE Helpers

    private func generateCodeVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func generateCodeChallenge(from verifier: String) -> String? {
        guard let data = verifier.data(using: .ascii) else { return nil }
        let hash = SHA256.hash(data: data)
        return Data(hash)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

// MARK: - ASWebAuthenticationSession Presentation

private final class PresentationContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(macOS)
        return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
        #else
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first(where: { $0.isKeyWindow }) ?? ASPresentationAnchor()
        #endif
    }
}
