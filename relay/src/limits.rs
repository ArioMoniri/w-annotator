//! Every number that bounds what a client can make the relay do or hold.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

const MIB: usize = 1024 * 1024;

/// Size, count and rate limits for rooms v2. Protocol v1 keeps its own constants.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Largest websocket message (header included).
    pub max_message_bytes: usize,
    /// Largest JSON control message after the handshake.
    pub max_control_bytes: usize,
    /// Largest handshake message (`create`, `auth`, `redeem`).
    pub max_handshake_bytes: usize,
    /// Outbound queue per connection; a member that falls behind is closed with 4002.
    pub queue_bytes: usize,
    pub queue_messages: usize,
    /// Members per room, host included.
    pub max_members: usize,
    /// Rooms the relay holds at once.
    pub max_rooms: usize,
    /// Open v2 connections, signed in or not.
    pub max_connections: usize,
    /// Invites a room holds at once, spent and revoked ones included until forgotten.
    pub max_invites: usize,
    /// Per connection; going over closes it with 4429.
    pub messages_per_sec: u32,
    pub bytes_per_sec: usize,
    /// Per room, all members together; frames over it are dropped with an error.
    pub room_messages_per_sec: u32,
    pub room_bytes_per_sec: usize,
    /// Connection attempts to `/v2/` per IP address per minute.
    pub joins_per_minute: u32,
    /// Slice requests per guest in a view-through-host room.
    pub slice_requests_burst: u32,
    pub slice_requests_per_minute: u32,
    /// Wrong invite proofs before the invite is locked for `Timing::invite_lock`.
    pub invite_failures: u32,
    /// The replay log per room, in frames and in bytes.
    pub log_frames: usize,
    pub log_bytes: usize,
    /// Removed keys and tombstones remembered.
    pub removed_keys: usize,
    pub tombstones: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_message_bytes: 2 * MIB,
            max_control_bytes: 16 * 1024,
            max_handshake_bytes: 8 * 1024,
            queue_bytes: 16 * MIB,
            queue_messages: 1024,
            max_members: 16,
            max_rooms: 1024,
            max_connections: 4096,
            max_invites: 64,
            messages_per_sec: 200,
            bytes_per_sec: 20 * MIB,
            room_messages_per_sec: 800,
            room_bytes_per_sec: 80 * MIB,
            joins_per_minute: 30,
            slice_requests_burst: 30,
            slice_requests_per_minute: 600,
            invite_failures: 5,
            log_frames: 2048,
            log_bytes: 8 * MIB,
            removed_keys: 256,
            tombstones: 4096,
        }
    }
}

/// Timeouts and lifetimes for rooms v2.
#[derive(Debug, Clone)]
pub struct Timing {
    /// Time a new connection has to send its handshake.
    pub handshake_timeout: Duration,
    /// Ping interval and silence limit for shared-copy rooms.
    pub ping_interval: Duration,
    pub idle_timeout: Duration,
    /// Ping interval and silence limit in view-through-host rooms.
    pub host_ping_interval: Duration,
    pub host_timeout: Duration,
    /// How long a view-through-host room waits for a host whose connection broke.
    pub host_grace: Duration,
    /// Invite lifetime when the host does not ask for one, and the longest allowed.
    pub invite_default_ttl: Duration,
    pub invite_max_ttl: Duration,
    /// Spent, expired and revoked invites are forgotten this long after expiry.
    pub invite_forget: Duration,
    /// Lock on an invite after too many wrong proofs.
    pub invite_lock: Duration,
    /// A member that has not connected for this long stops being a member.
    pub member_idle_ttl: Duration,
    /// A room nobody has been connected to for this long is forgotten.
    pub room_idle_ttl: Duration,
    /// How long a deleted or closed room id answers 4410.
    pub tombstone_ttl: Duration,
    /// How often expiry is checked.
    pub sweep_interval: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        const DAY: u64 = 24 * 60 * 60;
        Timing {
            handshake_timeout: Duration::from_secs(10),
            ping_interval: Duration::from_secs(20),
            idle_timeout: Duration::from_secs(60),
            host_ping_interval: Duration::from_secs(5),
            host_timeout: Duration::from_secs(15),
            host_grace: Duration::from_secs(15),
            invite_default_ttl: Duration::from_secs(DAY),
            invite_max_ttl: Duration::from_secs(7 * DAY),
            invite_forget: Duration::from_secs(DAY),
            invite_lock: Duration::from_secs(10 * 60),
            member_idle_ttl: Duration::from_secs(30 * DAY),
            room_idle_ttl: Duration::from_secs(30 * DAY),
            tombstone_ttl: Duration::from_secs(30 * DAY),
            sweep_interval: Duration::from_secs(60),
        }
    }
}

/// A token bucket: `capacity` tokens, refilled at `per_sec`.
#[derive(Debug)]
pub struct Bucket {
    tokens: f64,
    capacity: f64,
    per_sec: f64,
    at: Instant,
}

impl Bucket {
    pub fn new(capacity: f64, per_sec: f64) -> Self {
        Bucket {
            tokens: capacity,
            capacity,
            per_sec,
            at: Instant::now(),
        }
    }

    /// Takes `n` tokens if they are there.
    pub fn take(&mut self, n: f64) -> bool {
        self.take_at(n, Instant::now())
    }

    fn take_at(&mut self, n: f64, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        self.at = now;
        self.tokens = (self.tokens + elapsed * self.per_sec).min(self.capacity);
        if self.tokens >= n {
            self.tokens -= n;
            true
        } else {
            false
        }
    }

    fn is_full_at(&self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        self.tokens + elapsed * self.per_sec >= self.capacity
    }
}

/// Messages and bytes together, for one connection or one room.
#[derive(Debug)]
pub struct RateLimit {
    messages: Bucket,
    bytes: Bucket,
}

impl RateLimit {
    /// One second's worth of burst. The byte bucket always fits one full message.
    pub fn new(messages_per_sec: u32, bytes_per_sec: usize, max_message: usize) -> Self {
        let bytes = bytes_per_sec as f64;
        RateLimit {
            messages: Bucket::new(f64::from(messages_per_sec), f64::from(messages_per_sec)),
            bytes: Bucket::new(bytes.max(max_message as f64), bytes),
        }
    }

    pub fn allow(&mut self, len: usize) -> bool {
        self.messages.take(1.0) && self.bytes.take(len as f64)
    }
}

/// Connection attempts per IP address. Addresses live only here, in memory,
/// and are forgotten as soon as their bucket is full again.
#[derive(Debug)]
pub struct IpLimiter {
    per_minute: u32,
    seen: HashMap<IpAddr, Bucket>,
}

/// Addresses tracked at once. Past this, old entries are pruned before a new one is added.
const MAX_TRACKED_IPS: usize = 16_384;

impl IpLimiter {
    pub fn new(per_minute: u32) -> Self {
        IpLimiter {
            per_minute,
            seen: HashMap::new(),
        }
    }

    pub fn allow(&mut self, ip: IpAddr) -> bool {
        if self.seen.len() >= MAX_TRACKED_IPS && !self.seen.contains_key(&ip) {
            self.prune();
            if self.seen.len() >= MAX_TRACKED_IPS {
                // Under a flood from more addresses than we track, fail closed.
                return false;
            }
        }
        let rate = f64::from(self.per_minute);
        self.seen
            .entry(ip)
            .or_insert_with(|| Bucket::new(rate, rate / 60.0))
            .take(1.0)
    }

    /// Forgets addresses that have not connected recently.
    pub fn prune(&mut self) {
        let now = Instant::now();
        self.seen.retain(|_, bucket| !bucket.is_full_at(now));
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.seen.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_allows_a_burst_then_refills_at_its_rate() {
        let start = Instant::now();
        let mut bucket = Bucket::new(3.0, 2.0);
        bucket.at = start;
        assert!(bucket.take_at(1.0, start));
        assert!(bucket.take_at(2.0, start));
        assert!(!bucket.take_at(1.0, start));
        // Half a second later one token is back.
        let later = start + Duration::from_millis(500);
        assert!(bucket.take_at(1.0, later));
        assert!(!bucket.take_at(1.0, later));
        // It never holds more than its capacity.
        let much_later = later + Duration::from_secs(3600);
        assert!(bucket.take_at(3.0, much_later));
        assert!(!bucket.take_at(0.5, much_later));
    }

    #[test]
    fn rate_limit_counts_messages_and_bytes() {
        let mut limit = RateLimit::new(1000, 100, 60);
        assert!(limit.allow(60));
        assert!(limit.allow(40));
        assert!(!limit.allow(1));
        let mut limit = RateLimit::new(2, 1_000_000, 10);
        assert!(limit.allow(1));
        assert!(limit.allow(1));
        assert!(!limit.allow(1));
        // A byte rate below one message still lets a full message through.
        let mut limit = RateLimit::new(10, 5, 50);
        assert!(limit.allow(50));
    }

    #[test]
    fn ip_limiter_is_per_address_and_forgets_idle_ones() {
        let a: IpAddr = "10.0.0.1".parse().unwrap();
        let b: IpAddr = "10.0.0.2".parse().unwrap();
        let mut limiter = IpLimiter::new(2);
        assert!(limiter.allow(a));
        assert!(limiter.allow(a));
        assert!(!limiter.allow(a));
        assert!(limiter.allow(b));
        assert_eq!(limiter.len(), 2);
        // Pretend a minute passed for `b`.
        limiter.seen.get_mut(&b).unwrap().at = Instant::now() - Duration::from_secs(120);
        limiter.prune();
        assert_eq!(limiter.len(), 1);
    }

    #[test]
    fn default_limits_are_the_designed_ones() {
        let l = Limits::default();
        assert_eq!(l.max_message_bytes, 2 * MIB);
        assert_eq!(l.queue_bytes, 16 * MIB);
        assert_eq!(l.max_members, 16);
        assert_eq!((l.messages_per_sec, l.bytes_per_sec), (200, 20 * MIB));
        assert_eq!(l.invite_failures, 5);
        assert!(
            l.log_bytes <= l.queue_bytes / 2,
            "a replay must fit a queue"
        );
        let t = Timing::default();
        assert_eq!(t.host_ping_interval, Duration::from_secs(5));
        assert_eq!(t.host_timeout, Duration::from_secs(15));
        assert_eq!(t.invite_default_ttl, Duration::from_secs(86_400));
        assert_eq!(t.invite_lock, Duration::from_secs(600));
    }
}
