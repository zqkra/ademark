// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ademark-native",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ademark-native",
            path: "Sources/ademark-native",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
