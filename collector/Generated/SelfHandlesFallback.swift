// Compiled only where SelfHandles.generated.swift is not (SwiftPM dev builds and the
// BlackbookServerTests bundle). An empty list means every send is refused with
// `recipient_not_allowed`. The app target compiles the generated file instead; its pre-build
// script writes an empty stub when the file is missing, so a fresh checkout still builds.

enum GeneratedSelfHandles {
    static let handles: [String] = []
}
