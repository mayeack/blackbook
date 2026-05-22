import SwiftUI
import SwiftData

@main
struct BlackbookServerApp: App {
    private let modelContainer: ModelContainer?
    @State private var model: ServerStatusModel

    init() {
        let container = ServerModelContainer.make()
        self.modelContainer = container
        _model = State(initialValue: ServerStatusModel(modelContainer: container))
    }

    var body: some Scene {
        MenuBarExtra("Blackbook Server", systemImage: "server.rack") {
            ServerMenuView(model: model)
        }
        .menuBarExtraStyle(.window)
    }
}
