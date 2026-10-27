import Foundation

/// PA-Sig request signing (catalog General).
public enum RequestSigning {
    /// "PA-REQ1\n" + METHOD + "\n" + path + "\n" + PA-Time + "\n" + raw body bytes
    public static func signedBytes(method: String, path: String, paTime: String, body: Data) -> Data {
        Bytes.ascii("PA-REQ1\n" + method + "\n" + path + "\n" + paTime + "\n") + body
    }

    /// Decimal unix ms.
    public static func paTime(ms: Int64) -> String { String(ms) }

    /// Verify a PA-Sig as the Worker does: 13-digit PA-Time, path under /v1/, 64-byte raw
    /// signature over the exact bytes.
    public static func verify(method: String, path: String, paTime: String, body: Data, sig: Data, signPub: Data) -> Bool {
        guard paTime.utf8.count == 13, paTime.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), path.hasPrefix("/v1/") else {
            return false
        }
        return Signatures.verify(sig, data: signedBytes(method: method, path: path, paTime: paTime, body: body), publicKey: signPub)
    }

    /// PA-ID (when given), PA-Time, PA-Sig.
    public static func headers(signer: PASigner, peerId: PeerId?, method: String, path: String,
                               timeMs: Int64, body: Data) throws -> [String: String] {
        let t = paTime(ms: timeMs)
        let sig = try signer.sign(signedBytes(method: method, path: path, paTime: t, body: body))
        var h = ["PA-Time": t, "PA-Sig": B64URL.encode(sig)]
        if let id = peerId { h["PA-ID"] = id.text }
        return h
    }
}
