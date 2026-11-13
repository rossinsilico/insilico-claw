import CryptoKit
import Foundation
import Security

@objc(FaceclawGatewayIdentity)
@objcMembers
public final class FaceclawGatewayIdentity: NSObject {
    private enum IdentityError: LocalizedError {
        case invalidOrigin
        case missingBundleIdentifier
        case keychain(OSStatus)
        case invalidStoredKey
        case serialization

        var errorDescription: String? {
            switch self {
            case .invalidOrigin: return "Gateway origin must be an HTTPS origin"
            case .missingBundleIdentifier: return "App bundle identifier is unavailable"
            case .keychain(let status): return "Gateway identity Keychain operation failed (\(status))"
            case .invalidStoredKey: return "Stored gateway identity is invalid"
            case .serialization: return "Gateway identity result could not be encoded"
            }
        }
    }

    @objc(signGatewayChallenge:token:scopes:nonce:signedAtMs:)
    public static func signGatewayChallenge(
        _ origin: String,
        token: String,
        scopes: [String],
        nonce: String,
        signedAtMs: Int64
    ) -> String {
        do {
            let account = try keychainAccount(forOrigin: origin)
            let privateKey = try loadOrCreatePrivateKey(account: account)
            let result = try signedChallenge(
                privateKeyRawRepresentation: privateKey.rawRepresentation,
                token: token,
                scopes: scopes,
                nonce: nonce,
                signedAtMs: signedAtMs
            )
            return try json(result)
        } catch {
            return (try? json(["error": error.localizedDescription])) ?? "{\"error\":\"Gateway identity failed\"}"
        }
    }

    static func signedChallenge(
        privateKeyRawRepresentation: Data,
        token: String,
        scopes: [String],
        nonce: String,
        signedAtMs: Int64
    ) throws -> [String: Any] {
        let privateKey: Curve25519.Signing.PrivateKey // gitleaks:allow -- type declaration; key bytes are loaded at runtime
        do {
            privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: privateKeyRawRepresentation)
        } catch {
            throw IdentityError.invalidStoredKey
        }
        let publicKey = privateKey.publicKey.rawRepresentation
        let deviceId = SHA256.hash(data: publicKey).map { String(format: "%02x", $0) }.joined()
        let payload = [
            "v3", deviceId, "webchat-ui", "ui", "operator",
            scopes.joined(separator: ","), String(signedAtMs), token, nonce, "ios", "iphone",
        ].joined(separator: "|")
        let signature = try privateKey.signature(for: Data(payload.utf8))
        return [
            "id": deviceId,
            "publicKey": publicKey.base64URLEncodedString(),
            "signature": signature.base64URLEncodedString(),
            "signedAt": signedAtMs,
            "nonce": nonce,
        ]
    }

    static func keychainAccount(forOrigin origin: String) throws -> String {
        guard origin == origin.trimmingCharacters(in: .whitespacesAndNewlines),
              let components = URLComponents(string: origin),
              components.scheme?.lowercased() == "https",
              let rawHost = components.host, !rawHost.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.percentEncodedPath.isEmpty || components.percentEncodedPath == "/" else {
            throw IdentityError.invalidOrigin
        }
        let host = rawHost.lowercased()
        let renderedHost = host.contains(":") ? "[\(host)]" : host
        let port = components.port.flatMap { $0 == 443 ? nil : ":\($0)" } ?? ""
        return "https://\(renderedHost)\(port)"
    }

    private static func loadOrCreatePrivateKey(account: String) throws -> Curve25519.Signing.PrivateKey {
        if let stored = try loadPrivateKey(account: account) {
            do { return try Curve25519.Signing.PrivateKey(rawRepresentation: stored) }
            catch { throw IdentityError.invalidStoredKey }
        }
        let key = Curve25519.Signing.PrivateKey()
        do {
            try savePrivateKey(key.rawRepresentation, account: account)
            return key
        } catch IdentityError.keychain(errSecDuplicateItem) {
            guard let stored = try loadPrivateKey(account: account) else { throw IdentityError.keychain(errSecItemNotFound) }
            do { return try Curve25519.Signing.PrivateKey(rawRepresentation: stored) }
            catch { throw IdentityError.invalidStoredKey }
        }
    }

    private static func loadPrivateKey(account: String) throws -> Data? {
        var query = try keychainQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw IdentityError.keychain(status) }
        return data
    }

    private static func savePrivateKey(_ privateKey: Data, account: String) throws {
        var query = try keychainQuery(account: account)
        query[kSecValueData as String] = privateKey
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw IdentityError.keychain(status) }
    }

    private static func keychainQuery(account: String) throws -> [String: Any] {
        guard let bundleIdentifier = Bundle.main.bundleIdentifier else { throw IdentityError.missingBundleIdentifier }
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "\(bundleIdentifier).openclaw-gateway-identity",
            kSecAttrAccount as String: account,
        ]
    }

    private static func json(_ value: [String: Any]) throws -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let result = String(data: try JSONSerialization.data(withJSONObject: value), encoding: .utf8) else {
            throw IdentityError.serialization
        }
        return result
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
