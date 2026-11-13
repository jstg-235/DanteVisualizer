// swift-tools-version:5.9
// Builds with the Command Line Tools alone (no Xcode): `swift build -c release`.
// mac/build_app.sh wraps the binary into "Dante Visualizer.app".
import PackageDescription

let package = Package(
    name: "DanteVisualizer",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "DanteVisualizer",
            path: "Sources/DanteVisualizer",
            linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("WebKit")]
        )
    ]
)
