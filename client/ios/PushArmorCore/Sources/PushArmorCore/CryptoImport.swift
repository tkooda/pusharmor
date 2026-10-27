// One import point for the crypto backend: CryptoKit on Apple platforms,
// swift-crypto (same API) on Linux, where the package is only tested.
#if canImport(CryptoKit)
@_exported import CryptoKit
#else
@_exported import Crypto
#endif
@_exported import Foundation
