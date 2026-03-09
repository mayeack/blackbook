import XCTest
@testable import Blackbook

final class AuthStateTests: XCTestCase {

    func testAuthStateEquality() {
        XCTAssertEqual(AuthState.loading, AuthState.loading)
        XCTAssertEqual(AuthState.signedOut, AuthState.signedOut)
        XCTAssertEqual(
            AuthState.signedIn(userId: "abc"),
            AuthState.signedIn(userId: "abc")
        )
        XCTAssertNotEqual(
            AuthState.signedIn(userId: "abc"),
            AuthState.signedIn(userId: "xyz")
        )
        XCTAssertEqual(
            AuthState.confirmSignUp(email: "a@b.com"),
            AuthState.confirmSignUp(email: "a@b.com")
        )
        XCTAssertNotEqual(AuthState.loading, AuthState.signedOut)
    }

    func testAuthServiceInitialState() {
        let service = AuthenticationService()
        XCTAssertFalse(service.isSignedIn)
        XCTAssertNil(service.currentUserId)
        XCTAssertNil(service.error)
        XCTAssertFalse(service.isProcessing)
    }

    func testAuthServiceNavigateToSignIn() {
        let service = AuthenticationService()
        service.authState = .confirmSignUp(email: "test@test.com")
        service.error = AppAuthError.signInFailed("test")

        service.navigateToSignIn()

        XCTAssertEqual(service.authState, .signedOut)
        XCTAssertNil(service.error)
    }

    func testCurrentUserId() {
        let service = AuthenticationService()

        service.authState = .signedOut
        XCTAssertNil(service.currentUserId)

        service.authState = .signedIn(userId: "user-123")
        XCTAssertEqual(service.currentUserId, "user-123")
    }

    func testAuthErrorDescriptions() {
        let errors: [AppAuthError] = [
            .signInFailed("test"),
            .signUpFailed("test"),
            .confirmationFailed("test"),
            .resetFailed("test"),
            .signOutFailed("test"),
            .unknown("test")
        ]

        for error in errors {
            XCTAssertNotNil(error.errorDescription)
            XCTAssertEqual(error.errorDescription, "test")
        }
    }
}
