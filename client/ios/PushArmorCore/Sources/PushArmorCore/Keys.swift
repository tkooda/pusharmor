import Foundation

public enum PAKeyError: Error { case badPublicKey, badSignature, unavailable }

/// The device sign key (Secure Enclave on a phone, software in tests).
public protocol PASigner {
    /// 65-byte x963 public key.
    var publicKey: Data { get }
    /// ECDSA P-256 SHA-256, raw r||s, 64 bytes.
    func sign(_ data: Data) throws -> Data
}

/// The device enc key: an HPKE recipient (Secure Enclave or software).
public protocol PADecryptor {
    var publicKey: Data { get }
    func hpkeOpen(wire: Data, info: Data, aad: Data) throws -> Data
}

public struct SoftwareSigner: PASigner {
    public let key: P256.Signing.PrivateKey
    public init(key: P256.Signing.PrivateKey = P256.Signing.PrivateKey()) { self.key = key }
    public init(raw: Data) throws { key = try P256.Signing.PrivateKey(rawRepresentation: raw) }
    public var publicKey: Data { key.publicKey.x963Representation }
    public func sign(_ data: Data) throws -> Data { try key.signature(for: data).rawRepresentation }
}

public struct SoftwareDecryptor: PADecryptor {
    public let key: P256.KeyAgreement.PrivateKey
    public init(key: P256.KeyAgreement.PrivateKey = P256.KeyAgreement.PrivateKey()) { self.key = key }
    public init(raw: Data) throws { key = try P256.KeyAgreement.PrivateKey(rawRepresentation: raw) }
    public var publicKey: Data { key.publicKey.x963Representation }
    public func hpkeOpen(wire: Data, info: Data, aad: Data) throws -> Data {
        try HPKEWire.open(wire, key: key, info: info, aad: aad)
    }
}

#if canImport(CryptoKit) && !os(Linux)
/// Secure Enclave keys (section 3). Only usable on the device that made them.
public struct SecureEnclaveSigner: PASigner {
    public let key: SecureEnclave.P256.Signing.PrivateKey
    public init(key: SecureEnclave.P256.Signing.PrivateKey) { self.key = key }
    public init(blob: Data) throws {
        key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob)
    }
    public var publicKey: Data { key.publicKey.x963Representation }
    public func sign(_ data: Data) throws -> Data { try key.signature(for: data).rawRepresentation }
}

public struct SecureEnclaveDecryptor: PADecryptor {
    public let key: SecureEnclave.P256.KeyAgreement.PrivateKey
    public init(key: SecureEnclave.P256.KeyAgreement.PrivateKey) { self.key = key }
    public init(blob: Data) throws {
        key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob)
    }
    public var publicKey: Data { key.publicKey.x963Representation }
    public func hpkeOpen(wire: Data, info: Data, aad: Data) throws -> Data {
        try HPKEWire.open(wire, key: key, info: info, aad: aad)
    }
}
#endif

/// ECDSA verify with a 65-byte x963 public key and a 64-byte raw signature.
public enum Signatures {
    public static func verify(_ sig: Data, data: Data, publicKey: Data) -> Bool {
        guard sig.count == 64,
              let pk = try? P256.Signing.PublicKey(x963Representation: publicKey),
              let s = try? P256.Signing.ECDSASignature(rawRepresentation: sig) else { return false }
        return pk.isValidSignature(s, for: data)
    }
}

/// RFC 9180 base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM.
/// Wire form: enc(65) || ct+tag.
public enum HPKEWire {
    public static let suite = HPKE.Ciphersuite.P256_SHA256_AES_GCM_256
    public static let encLength = 65
    public static let tagLength = 16

    public static func seal(_ plaintext: Data, to encPub: Data, info: Data, aad: Data) throws -> Data {
        let pk = try P256.KeyAgreement.PublicKey(x963Representation: encPub)
        var sender = try HPKE.Sender(recipientKey: pk, ciphersuite: suite, info: info)
        let ct = try sender.seal(plaintext, authenticating: aad)
        return sender.encapsulatedKey + ct
    }

    public static func open<K: HPKEDiffieHellmanPrivateKey>(_ wire: Data, key: K, info: Data, aad: Data) throws -> Data {
        guard wire.count >= encLength + tagLength else { throw PAKeyError.badPublicKey }
        let w = Data(wire)
        var r = try HPKE.Recipient(privateKey: key, ciphersuite: suite, info: info,
                                   encapsulatedKey: w.prefix(encLength))
        return try r.open(w.dropFirst(encLength), authenticating: aad)
    }
}
