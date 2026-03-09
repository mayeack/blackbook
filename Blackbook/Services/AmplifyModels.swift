import Amplify

/// Amplify model registry for AppSync GraphQL schema.
/// When you generate models via `amplify codegen models`, replace this
/// file with the generated AmplifyModels.swift.
struct AmplifyModels: AmplifyModelRegistration {
    let version: String = "1"

    func registerModels(registry: ModelRegistry.Type) {
        // Models will be registered here after running `amplify codegen models`.
        // For now, the app uses SwiftData locally and syncs via custom AWSSyncService.
    }
}
