// swift-tools-version:5.10
import PackageDescription

// PushArmorCore: crypto, wire codec, API client, store and rules shared by the
// app, the Notification Service Extension and the share extension.
// On Apple platforms it uses CryptoKit, Compression and SQLite3 from the SDK.
// On Linux (tests only) it uses swift-crypto, the system zlib and the system
// SQLite library; nothing of that is linked into the iOS targets.
let package = Package(
    name: "PushArmorCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PushArmorCore", targets: ["PushArmorCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-crypto.git", "3.8.0"..<"4.0.0"),
    ],
    targets: [
        .systemLibrary(name: "CZlib", path: "Sources/CZlib"),
        .systemLibrary(name: "CSQLite", path: "Sources/CSQLite"),
        .target(
            name: "PushArmorCore",
            dependencies: [
                .product(name: "Crypto", package: "swift-crypto",
                         condition: .when(platforms: [.linux])),
                .target(name: "CZlib", condition: .when(platforms: [.linux])),
                .target(name: "CSQLite", condition: .when(platforms: [.linux])),
            ]
        ),
        .testTarget(
            name: "PushArmorCoreTests",
            dependencies: ["PushArmorCore"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
