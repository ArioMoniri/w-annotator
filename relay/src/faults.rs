//! Fault injection for tests. A relay only has these hooks when its
//! [`RelayConfig`](crate::RelayConfig) is given a [`Faults`] handle; the
//! `w-relay` binary and the desktop app never do. Nothing here is reachable
//! from the network.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use tokio::sync::watch;

use crate::Shared;

#[derive(Default, Clone)]
struct Rule {
    drop_inbound: u32,
    drop_outbound: u32,
    delay_outbound: Option<Duration>,
    reorder_outbound: bool,
    silent: bool,
}

struct Inner {
    clock_offset_ms: AtomicU64,
    rules: Mutex<HashMap<(String, u32), Rule>>,
    paused: Mutex<HashSet<String>>,
    /// Bumped on every resume so waiting writers look again.
    resumed: watch::Sender<u64>,
    relay: Mutex<Weak<Shared>>,
}

/// A handle for breaking things on purpose: one member's link, a connection,
/// a room's delivery, or the clock. Rooms are named by id, members by member id.
#[derive(Clone)]
pub struct Faults(Arc<Inner>);

impl Default for Faults {
    fn default() -> Self {
        Faults(Arc::new(Inner {
            clock_offset_ms: AtomicU64::new(0),
            rules: Mutex::new(HashMap::new()),
            paused: Mutex::new(HashSet::new()),
            resumed: watch::channel(0).0,
            relay: Mutex::new(Weak::new()),
        }))
    }
}

impl std::fmt::Debug for Faults {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Faults")
    }
}

/// What the writer does with the next message for a member.
pub(crate) enum Outbound {
    Pass,
    Drop,
    Delay(Duration),
    /// Hold this frame and send it after the next binary frame.
    Hold,
}

impl Faults {
    pub fn new() -> Self {
        Self::default()
    }

    fn key(room: &str, member: u32) -> (String, u32) {
        (room.to_ascii_uppercase(), member)
    }

    fn rule(&self, room: &str, member: u32, change: impl FnOnce(&mut Rule)) {
        let mut rules = self.0.rules.lock().unwrap();
        change(rules.entry(Self::key(room, member)).or_default());
    }

    /// The relay ignores the next `count` binary frames this member sends.
    pub fn drop_inbound(&self, room: &str, member: u32, count: u32) {
        self.rule(room, member, |r| r.drop_inbound = count);
    }

    /// The next `count` binary frames for this member are lost on the way out.
    pub fn drop_outbound(&self, room: &str, member: u32, count: u32) {
        self.rule(room, member, |r| r.drop_outbound = count);
    }

    /// Every message for this member waits this long before it is written.
    /// Order is kept. `Duration::ZERO` turns it off.
    pub fn delay_outbound(&self, room: &str, member: u32, delay: Duration) {
        self.rule(room, member, |r| {
            r.delay_outbound = (!delay.is_zero()).then_some(delay)
        });
    }

    /// The next two binary frames for this member arrive in swapped order.
    pub fn reorder_outbound(&self, room: &str, member: u32) {
        self.rule(room, member, |r| r.reorder_outbound = true);
    }

    /// The member's link goes dead without closing: nothing it sends is seen,
    /// nothing is sent to it, as when a lid is shut. The relay notices only by
    /// its liveness timeout.
    pub fn silence(&self, room: &str, member: u32) {
        self.rule(room, member, |r| r.silent = true);
    }

    /// Removes every rule for this member.
    pub fn heal(&self, room: &str, member: u32) {
        self.0
            .rules
            .lock()
            .unwrap()
            .remove(&Self::key(room, member));
    }

    /// Cuts the member's connection at once, without a close frame.
    /// Returns whether the member was connected.
    pub fn kill(&self, room: &str, member: u32) -> bool {
        match self.relay() {
            Some(shared) => crate::rooms::kill(&shared, &room.to_ascii_uppercase(), member),
            None => false,
        }
    }

    /// Stops all delivery in a room. Frames queue up, in order, until
    /// [`resume_room`](Self::resume_room).
    pub fn pause_room(&self, room: &str) {
        self.0
            .paused
            .lock()
            .unwrap()
            .insert(room.to_ascii_uppercase());
    }

    pub fn resume_room(&self, room: &str) {
        self.0
            .paused
            .lock()
            .unwrap()
            .remove(&room.to_ascii_uppercase());
        self.0.resumed.send_modify(|n| *n += 1);
    }

    /// Moves the relay's clock forward. Affects invite expiry, idle expiry and
    /// tombstones, not network timeouts.
    pub fn advance_clock(&self, by: Duration) {
        self.0
            .clock_offset_ms
            .fetch_add(by.as_millis() as u64, Ordering::Relaxed);
    }

    /// Runs the expiry sweep now instead of waiting for its timer.
    pub fn sweep(&self) {
        if let Some(shared) = self.relay() {
            crate::rooms::sweep(&shared);
        }
    }

    /// Forgets every v2 room and cuts every v2 connection, as a restart would.
    pub fn wipe(&self) {
        if let Some(shared) = self.relay() {
            crate::rooms::wipe(&shared);
        }
    }

    fn relay(&self) -> Option<Arc<Shared>> {
        self.0.relay.lock().unwrap().upgrade()
    }

    pub(crate) fn attach(&self, shared: &Arc<Shared>) {
        *self.0.relay.lock().unwrap() = Arc::downgrade(shared);
    }

    pub(crate) fn clock_offset_ms(&self) -> u64 {
        self.0.clock_offset_ms.load(Ordering::Relaxed)
    }

    pub(crate) fn is_silent(&self, room: &str, member: u32) -> bool {
        let rules = self.0.rules.lock().unwrap();
        rules
            .get(&(room.to_owned(), member))
            .is_some_and(|r| r.silent)
    }

    /// Whether to ignore a binary frame the member just sent.
    pub(crate) fn drops_inbound(&self, room: &str, member: u32) -> bool {
        let mut rules = self.0.rules.lock().unwrap();
        match rules.get_mut(&(room.to_owned(), member)) {
            Some(rule) if rule.drop_inbound > 0 => {
                rule.drop_inbound -= 1;
                true
            }
            _ => false,
        }
    }

    pub(crate) fn outbound(
        &self,
        room: &str,
        member: u32,
        binary: bool,
        holding: bool,
    ) -> Outbound {
        let mut rules = self.0.rules.lock().unwrap();
        let Some(rule) = rules.get_mut(&(room.to_owned(), member)) else {
            return Outbound::Pass;
        };
        if rule.silent {
            return Outbound::Drop;
        }
        if binary {
            if rule.drop_outbound > 0 {
                rule.drop_outbound -= 1;
                return Outbound::Drop;
            }
            if rule.reorder_outbound && !holding {
                rule.reorder_outbound = false;
                return Outbound::Hold;
            }
        }
        match rule.delay_outbound {
            Some(delay) => Outbound::Delay(delay),
            None => Outbound::Pass,
        }
    }

    /// Resolves once the room is not paused.
    pub(crate) async fn wait_unpaused(&self, room: &str) {
        let mut resumed = self.0.resumed.subscribe();
        loop {
            if !self.0.paused.lock().unwrap().contains(room) {
                return;
            }
            if resumed.changed().await.is_err() {
                return;
            }
        }
    }
}
