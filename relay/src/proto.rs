//! Protocol v2 wire constants: versions, close codes, frame kinds and the
//! cleartext binary header. The written spec is `docs/design/ROOMS-PROTOCOL.md`.

/// The only protocol version this relay speaks on `/v2/`.
pub const PROTO_VERSION: u8 = 3;

/// Length of the cleartext header in front of every binary frame.
pub const HEADER_LEN: usize = 24;

/// Websocket close codes the relay sends.
pub mod close {
    /// The room has its 16 members, or the relay has no space for another room.
    pub const FULL: u16 = 4001;
    /// The member did not keep up with the room and its queue overflowed.
    pub const TOO_SLOW: u16 = 4002;
    /// The same member signed in on another connection.
    pub const REPLACED: u16 = 4003;
    /// The handshake was malformed or did not arrive in time.
    pub const BAD_REQUEST: u16 = 4400;
    /// The key is not a member of the room, or the signature is wrong.
    pub const NOT_MEMBER: u16 = 4401;
    /// The host removed this member.
    pub const REMOVED: u16 = 4403;
    /// No such room.
    pub const NO_ROOM: u16 = 4404;
    /// The invite is expired, used up, revoked or not valid.
    pub const INVITE: u16 = 4408;
    /// `create` for a room id that is taken.
    pub const EXISTS: u16 = 4409;
    /// The room was deleted or closed.
    pub const GONE: u16 = 4410;
    /// Protocol version mismatch.
    pub const VERSION: u16 = 4426;
    /// Too many messages, bytes or attempts.
    pub const RATE_LIMITED: u16 = 4429;
}

/// Frame kinds the relay knows. Other values are ignored, never fatal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    /// A voxel patch. Edit class: ordered.
    Patch = 1,
    /// A segment operation. Edit class: ordered.
    SegOp = 2,
    /// A slab of the mask for join or catch-up. File class.
    SyncSlab = 3,
    /// A slab of the image. File class.
    ImageSlab = 4,
    /// Cursor and similar. Unordered and droppable.
    Presence = 5,
    /// A guest asks the host for a slice (view-through-host).
    SliceRequest = 6,
    /// The host answers with a windowed slice (view-through-host).
    Slice = 7,
    /// Key delivery to one member.
    Key = 8,
    /// A member asks another member for slabs. File class.
    SyncRequest = 9,
}

impl Kind {
    /// The kind for a header byte, or `None` for a value this relay does not know.
    pub fn from_u8(value: u8) -> Option<Self> {
        Some(match value {
            1 => Kind::Patch,
            2 => Kind::SegOp,
            3 => Kind::SyncSlab,
            4 => Kind::ImageSlab,
            5 => Kind::Presence,
            6 => Kind::SliceRequest,
            7 => Kind::Slice,
            8 => Kind::Key,
            9 => Kind::SyncRequest,
            _ => return None,
        })
    }

    /// Edit-class frames get a sequence number.
    pub fn is_edit(self) -> bool {
        matches!(self, Kind::Patch | Kind::SegOp)
    }

    /// File-class frames carry (or ask for) the image or the whole mask.
    pub fn is_file(self) -> bool {
        matches!(self, Kind::SyncSlab | Kind::ImageSlab | Kind::SyncRequest)
    }
}

/// Why a binary frame could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    /// Shorter than [`HEADER_LEN`].
    Truncated,
    /// The version byte is not [`PROTO_VERSION`].
    Version(u8),
}

/// The cleartext header of a binary frame. All integers are little-endian.
///
/// ```text
/// offset 0  u8  version   always 2
/// offset 1  u8  kind
/// offset 2  u16 flags     passed through untouched
/// offset 4  u32 from      set by the relay
/// offset 8  u32 to        0 = everyone else
/// offset 12 u64 seq       client: its own op id; relay: the room sequence number on ordered frames
/// offset 20 u32 epoch     key epoch
/// offset 24 payload       opaque to the relay
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub version: u8,
    pub kind: u8,
    pub flags: u16,
    pub from: u32,
    pub to: u32,
    pub seq: u64,
    pub epoch: u32,
}

impl Header {
    /// Reads the header at the start of `data`.
    pub fn parse(data: &[u8]) -> Result<Self, FrameError> {
        let Some(head) = data.get(..HEADER_LEN) else {
            return Err(FrameError::Truncated);
        };
        if head[0] != PROTO_VERSION {
            return Err(FrameError::Version(head[0]));
        }
        let u32_at =
            |o: usize| u32::from_le_bytes([head[o], head[o + 1], head[o + 2], head[o + 3]]);
        let mut seq = [0u8; 8];
        seq.copy_from_slice(&head[12..20]);
        Ok(Header {
            version: head[0],
            kind: head[1],
            flags: u16::from_le_bytes([head[2], head[3]]),
            from: u32_at(4),
            to: u32_at(8),
            seq: u64::from_le_bytes(seq),
            epoch: u32_at(20),
        })
    }

    /// The 24 header bytes.
    pub fn encode(&self) -> [u8; HEADER_LEN] {
        let mut out = [0u8; HEADER_LEN];
        out[0] = self.version;
        out[1] = self.kind;
        out[2..4].copy_from_slice(&self.flags.to_le_bytes());
        out[4..8].copy_from_slice(&self.from.to_le_bytes());
        out[8..12].copy_from_slice(&self.to.to_le_bytes());
        out[12..20].copy_from_slice(&self.seq.to_le_bytes());
        out[20..24].copy_from_slice(&self.epoch.to_le_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trips_and_matches_the_documented_bytes() {
        let header = Header {
            version: 3,
            kind: Kind::Patch as u8,
            flags: 0x0102,
            from: 0x0A0B_0C0D,
            to: 7,
            seq: 0x1122_3344_5566_7788,
            epoch: 1,
        };
        let bytes = header.encode();
        assert_eq!(
            bytes,
            [
                0x03, 0x01, 0x02, 0x01, 0x0D, 0x0C, 0x0B, 0x0A, 0x07, 0x00, 0x00, 0x00, 0x88, 0x77,
                0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x01, 0x00, 0x00, 0x00
            ]
        );
        assert_eq!(Header::parse(&bytes), Ok(header));
        // A payload after the header does not matter.
        let mut longer = bytes.to_vec();
        longer.extend_from_slice(b"payload");
        assert_eq!(Header::parse(&longer), Ok(header));
    }

    #[test]
    fn short_and_wrong_version_headers_are_errors_not_panics() {
        let good = Header {
            version: 3,
            kind: 1,
            flags: 0,
            from: 0,
            to: 0,
            seq: 0,
            epoch: 1,
        }
        .encode();
        for len in 0..HEADER_LEN {
            assert_eq!(Header::parse(&good[..len]), Err(FrameError::Truncated));
        }
        for version in [0u8, 1, 2, 255] {
            let mut bad = good;
            bad[0] = version;
            assert_eq!(Header::parse(&bad), Err(FrameError::Version(version)));
        }
    }

    #[test]
    fn every_byte_pattern_parses_or_fails_cleanly() {
        // A cheap deterministic generator; the point is that nothing panics.
        let mut x: u32 = 0x9E37_79B9;
        for _ in 0..20_000 {
            let mut buf = [0u8; 40];
            for b in &mut buf {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                *b = x as u8;
            }
            let len = (x as usize) % buf.len();
            if let Ok(h) = Header::parse(&buf[..len]) {
                assert_eq!(h.encode(), buf[..HEADER_LEN]);
                let _ = Kind::from_u8(h.kind);
            }
        }
    }

    #[test]
    fn kinds_have_the_designed_numbers_and_classes() {
        for (n, kind) in [
            (1, Kind::Patch),
            (2, Kind::SegOp),
            (3, Kind::SyncSlab),
            (4, Kind::ImageSlab),
            (5, Kind::Presence),
            (6, Kind::SliceRequest),
            (7, Kind::Slice),
            (8, Kind::Key),
            (9, Kind::SyncRequest),
        ] {
            assert_eq!(Kind::from_u8(n), Some(kind));
            assert_eq!(kind as u8, n);
        }
        assert_eq!(Kind::from_u8(0), None);
        assert_eq!(Kind::from_u8(10), None);
        assert!(Kind::Patch.is_edit() && Kind::SegOp.is_edit());
        assert!(!Kind::Presence.is_edit());
        assert!(
            Kind::SyncSlab.is_file() && Kind::ImageSlab.is_file() && Kind::SyncRequest.is_file()
        );
        assert!(!Kind::Slice.is_file());
    }
}
