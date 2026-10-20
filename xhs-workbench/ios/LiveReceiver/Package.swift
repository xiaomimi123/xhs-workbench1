// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "ReceiverCore", platforms: [.macOS(.v13), .iOS(.v17)], products: [.library(name: "ReceiverCore", targets: ["ReceiverCore"])], targets: [.target(name: "ReceiverCore"), .testTarget(name: "ReceiverCoreTests", dependencies: ["ReceiverCore"])])
