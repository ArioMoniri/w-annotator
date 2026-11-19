//! Identity for rooms v2: member keys, sign-in signatures and invite proofs.
//!
//! A member is an Ed25519 public key made for one room. Signing in proves
//! possession of the key by signing the relay's per-connection nonce. An invite
//! is redeemed with an HMAC keyed by a secret the relay was given by the host.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

/// Length of an Ed25519 or X25519 public key.
pub const KEY_LEN: usize = 32;
/// Length of an Ed25519 signature.
pub const SIG_LEN: usize = 64;
/// Length of the per-connection nonce.
pub const NONCE_LEN: usize = 32;

/// Unpadded URL-safe base64, the only binary-to-text encoding on the wire.
pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decodes exactly `N` bytes. Anything else, including padding, is `None`.
pub fn unb64<const N: usize>(text: &str) -> Option<[u8; N]> {
    // Cheap length check first, so a huge string is never decoded.
    if text.len() != (N * 4).div_ceil(3) {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(text).ok()?;
    bytes.try_into().ok()
}

/// Random bytes from the operating system.
pub fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::getrandom(&mut out).expect("the operating system has no random source");
    out
}

/// The member id for a public key: the first four bytes of its SHA-256, read
/// little-endian. Stable across reconnects and relay restarts. Zero is not a
/// valid id (it means "everyone" in a frame header).
pub fn member_id(key: &[u8; KEY_LEN]) -> u32 {
    let hash = Sha256::digest(key);
    u32::from_le_bytes([hash[0], hash[1], hash[2], hash[3]])
}

/// The bytes a client signs to `create`, `auth` or `redeem`:
/// `w-rooms/2 <op> <ROOM> <nonce>` in UTF-8, single spaces, no terminator.
pub fn signing_input(op: &str, room: &str, nonce: &str) -> Vec<u8> {
    format!("w-rooms/2 {op} {room} {nonce}").into_bytes()
}

/// The bytes an invite proof is computed over:
/// `w-rooms/2 proof <ROOM> <nonce> <key>` in UTF-8.
pub fn proof_input(room: &str, nonce: &str, key: &str) -> Vec<u8> {
    format!("w-rooms/2 proof {room} {nonce} {key}").into_bytes()
}

/// Checks an Ed25519 signature. Malformed keys and signatures are simply wrong.
pub fn verify_signature(key: &[u8; KEY_LEN], message: &[u8], signature: &[u8; SIG_LEN]) -> bool {
    let Ok(key) = VerifyingKey::from_bytes(key) else {
        return false;
    };
    key.verify_strict(message, &Signature::from_bytes(signature))
        .is_ok()
}

/// Checks an invite proof, HMAC-SHA256 keyed with the invite's auth key, in
/// constant time.
pub fn verify_proof(auth_key: &[u8; 32], message: &[u8], proof: &[u8; 32]) -> bool {
    let mut mac = Hmac::<Sha256>::new_from_slice(auth_key).expect("HMAC takes any key length");
    mac.update(message);
    mac.verify_slice(proof).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_is_url_safe_unpadded_and_length_checked() {
        assert_eq!(b64(&[0xFB, 0xFF]), "-_8");
        assert_eq!(unb64::<2>("-_8"), Some([0xFB, 0xFF]));
        assert_eq!(unb64::<2>("-_8="), None);
        assert_eq!(unb64::<2>("+/8"), None);
        assert_eq!(unb64::<3>("-_8"), None);
        assert_eq!(unb64::<32>(&"A".repeat(43)), Some([0u8; 32]));
        assert_eq!(unb64::<32>(&"A".repeat(44)), None);
        assert_eq!(unb64::<32>(&"A".repeat(1_000_000)), None);
        assert_eq!(unb64::<32>(""), None);
    }

    #[test]
    fn member_id_is_the_little_endian_start_of_the_key_hash() {
        // SHA-256 of 32 zero bytes starts 66 68 7a ad.
        assert_eq!(member_id(&[0u8; 32]), 0xAD7A_6866);
        assert_ne!(member_id(&[1u8; 32]), member_id(&[0u8; 32]));
    }

    #[test]
    fn signing_and_proof_inputs_are_the_documented_strings() {
        assert_eq!(
            signing_input("auth", "ROOM1234", "bm9uY2U"),
            b"w-rooms/2 auth ROOM1234 bm9uY2U"
        );
        assert_eq!(
            proof_input("ROOM1234", "bm9uY2U", "a2V5"),
            b"w-rooms/2 proof ROOM1234 bm9uY2U a2V5"
        );
    }

    #[test]
    fn rfc_8032_test_vector_verifies_and_any_change_does_not() {
        // RFC 8032, 7.1, test 2: a one-byte message.
        let key: [u8; 32] = hex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c");
        let sig: [u8; 64] = hex(
            "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da\
             085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
        );
        assert!(verify_signature(&key, &[0x72], &sig));
        assert!(!verify_signature(&key, &[0x73], &sig));
        let mut bad = sig;
        bad[0] ^= 1;
        assert!(!verify_signature(&key, &[0x72], &bad));
        // Bytes that are not a curve point are rejected, not a panic.
        assert!(!verify_signature(&[0xFF; 32], &[0x72], &sig));
    }

    #[test]
    fn proof_is_hmac_sha256() {
        // RFC 4231, test case 2.
        let mut key = [0u8; 32];
        key[..4].copy_from_slice(b"Jefe");
        // The RFC key is 4 bytes; HMAC pads with zeros, so the padded key is the same key.
        let proof: [u8; 32] =
            hex("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        assert!(verify_proof(&key, b"what do ya want for nothing?", &proof));
        assert!(!verify_proof(&key, b"what do ya want for nothing", &proof));
        let mut bad = proof;
        bad[31] ^= 0x80;
        assert!(!verify_proof(&key, b"what do ya want for nothing?", &bad));
    }

    fn hex<const N: usize>(text: &str) -> [u8; N] {
        let text: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        let mut out = [0u8; N];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&text[2 * i..2 * i + 2], 16).unwrap();
        }
        out
    }
}
