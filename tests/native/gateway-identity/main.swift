import CryptoKit
import Foundation

@main
struct GatewayIdentityTests {
    static func main() throws {
        let privateKey = Data(0..<32)
        let token = "shared-token"
        let nonce = "challenge-nonce"
        let signedAt: Int64 = 1_730_000_000_123
        let scopes = ["operator.read", "operator.write"]
        let result = try FaceclawGatewayIdentity.signedChallenge(
            privateKeyRawRepresentation: privateKey,
            token: token,
            scopes: scopes,
            nonce: nonce,
            signedAtMs: signedAt
        )

        let signingKey = try Curve25519.Signing.PrivateKey(rawRepresentation: privateKey)
        let publicKey = signingKey.publicKey.rawRepresentation
        let expectedDeviceId = SHA256.hash(data: publicKey).map { String(format: "%02x", $0) }.joined()
        precondition(expectedDeviceId == "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c")
        precondition(result["id"] as? String == expectedDeviceId)
        precondition(result["publicKey"] as? String == "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg")
        precondition(result["signedAt"] as? Int64 == signedAt)
        precondition(result["nonce"] as? String == nonce)

        let payload = [
            "v3", expectedDeviceId, "webchat-ui", "ui", "operator",
            scopes.joined(separator: ","), String(signedAt), token, nonce, "ios", "iphone",
        ].joined(separator: "|")
        guard let signatureText = result["signature"] as? String,
              let signature = Data(base64URLUnpadded: signatureText) else {
            preconditionFailure("missing signature")
        }
        precondition(signingKey.publicKey.isValidSignature(signature, for: Data(payload.utf8)))

        let normalized = try FaceclawGatewayIdentity.keychainAccount(forOrigin: "https://Gateway.Example/")
        let defaultPort = try FaceclawGatewayIdentity.keychainAccount(forOrigin: "https://gateway.example:443")
        let otherOrigin = try FaceclawGatewayIdentity.keychainAccount(forOrigin: "https://other.example")
        precondition(normalized == "https://gateway.example")
        precondition(defaultPort == normalized)
        precondition(otherOrigin != normalized)
        precondition((try? FaceclawGatewayIdentity.keychainAccount(forOrigin: "http://gateway.example")) == nil)
        precondition((try? FaceclawGatewayIdentity.keychainAccount(forOrigin: "https://gateway.example/path")) == nil)
    }
}

private extension Data {
    init?(base64URLUnpadded value: String) {
        let padding = String(repeating: "=", count: (4 - value.count % 4) % 4)
        self.init(base64Encoded: value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + padding)
    }
}
