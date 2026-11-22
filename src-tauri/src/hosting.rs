//! Hosting a room on the local network with the embedded relay.
//!
//! Shared-copy rooms outlive the app: what the relay needs to let their
//! members sign in again is kept in a file (`hosted_rooms`), read when hosting
//! starts and written while it runs and when it stops.

use std::io;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use w_relay::persist::SavedRelay;

use crate::hosted_rooms::{self, Found};

/// Port tried first when the caller does not ask for one.
pub const DEFAULT_PORT: u16 = 8787;

/// Where the hosted relay can be reached.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HostInfo {
    /// Port the relay listens on.
    pub port: u16,
    /// Non-loopback IPv4 addresses of this machine, e.g. `192.168.1.20`.
    pub addresses: Vec<String>,
}

/// How often the rooms are written while hosting, when they have changed. A
/// crash loses at most this much: someone who joined in that time needs a new link.
const SAVE_EVERY: Duration = Duration::from_secs(2);

struct Running {
    port: u16,
    stop: oneshot::Sender<()>,
    task: JoinHandle<io::Result<()>>,
    relay: w_relay::Relay,
    /// Where the rooms are kept, and the task that keeps them there.
    keeper: Option<(PathBuf, JoinHandle<()>)>,
}

/// Writes the relay's rooms to `dir` whenever they differ from what was last written.
async fn keep_rooms(relay: w_relay::Relay, dir: PathBuf, port: u16, mut last: SavedRelay) {
    let mut tick = tokio::time::interval(SAVE_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let now = relay.export();
        if now != last && hosted_rooms::write(&dir, port, &now).is_ok() {
            last = now;
        }
    }
}

/// The relay this app is hosting, if any.
#[derive(Default)]
pub struct Host(Mutex<Option<Running>>);

impl Host {
    /// Starts the relay, or returns the one already running. It listens on
    /// every interface when this computer has a network address to share, and
    /// on this computer only when it has none: then nobody else could use the
    /// link anyway, and nothing needs to be open to a network.
    /// If the wanted port is taken, the system picks a free one.
    ///
    /// With `store`, the rooms kept in that folder come back, on the port they
    /// had if it is free, and are kept there from now on.
    pub async fn start(&self, port: Option<u16>, store: Option<&Path>) -> io::Result<HostInfo> {
        let mut slot = self.0.lock().await;
        if let Some(running) = slot.as_ref() {
            if !running.task.is_finished() {
                return Ok(info(running.port));
            }
        }
        let found = store.map(hosted_rooms::read);
        let kept = match &found {
            Some(Found::Rooms(file)) => Some(file),
            _ => None,
        };
        // The address in people's links carries the port, so the same one is asked for again.
        let wanted = port.or(kept.map(|file| file.port)).unwrap_or(DEFAULT_PORT);
        let address = bind_address(&lan_addresses());
        let listener = match TcpListener::bind((address, wanted)).await {
            Ok(listener) => listener,
            Err(_) if wanted != 0 => TcpListener::bind((address, 0)).await?,
            Err(e) => return Err(e),
        };
        let port = listener.local_addr()?.port();
        let (stop, stopped) = oneshot::channel::<()>();
        // One person's rooms on a local network: the small configuration, protocol v2 only.
        let relay = w_relay::Relay::new(w_relay::RelayConfig::embedded());
        if let Some(file) = kept {
            // A record this build cannot read is not taken; hosting goes on without it.
            let _ = relay.import(file.relay.clone());
        }
        // What a newer version of the app wrote is never written over.
        let keeper = match (store, &found) {
            (Some(_), Some(Found::Newer)) | (None, _) => None,
            (Some(dir), _) => {
                let last = kept.map(|file| file.relay.clone()).unwrap_or_default();
                let job = keep_rooms(relay.clone(), dir.to_path_buf(), port, last);
                Some((dir.to_path_buf(), tokio::spawn(job)))
            }
        };
        let serving = relay.clone();
        let task = tokio::spawn(async move {
            serving
                .serve(listener, async {
                    let _ = stopped.await;
                })
                .await
        });
        *slot = Some(Running {
            port,
            stop,
            task,
            relay,
            keeper,
        });
        Ok(info(port))
    }

    /// Writes the rooms now, without stopping: for the moment the app quits.
    pub async fn keep_now(&self) {
        if let Some(running) = self.0.lock().await.as_ref() {
            if let Some((dir, _)) = &running.keeper {
                let _ = hosted_rooms::write(dir, running.port, &running.relay.export());
            }
        }
    }

    /// How many rooms the hosted relay holds; 0 when not hosting.
    #[cfg(test)]
    pub async fn rooms(&self) -> usize {
        match self.0.lock().await.as_ref() {
            Some(running) => running.relay.stats().rooms,
            None => 0,
        }
    }

    /// Stops the relay and waits until its port is free. Does nothing if not hosting.
    pub async fn stop(&self) {
        let Some(running) = self.0.lock().await.take() else {
            return;
        };
        if let Some((dir, keeper)) = running.keeper {
            // The last word on the rooms, before they go with the relay.
            keeper.abort();
            let _ = hosted_rooms::write(&dir, running.port, &running.relay.export());
        }
        let _ = running.stop.send(());
        let mut task = running.task;
        if tokio::time::timeout(Duration::from_secs(5), &mut task)
            .await
            .is_err()
        {
            task.abort();
        }
    }
}

/// Where the hosted relay listens, given this computer's network addresses.
pub fn bind_address(lan: &[String]) -> Ipv4Addr {
    if lan.is_empty() {
        Ipv4Addr::LOCALHOST
    } else {
        Ipv4Addr::UNSPECIFIED
    }
}

fn info(port: u16) -> HostInfo {
    HostInfo {
        port,
        addresses: lan_addresses(),
    }
}

/// Non-loopback, non-link-local IPv4 addresses of this machine.
pub fn lan_addresses() -> Vec<String> {
    let mut found: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|iface| match iface.ip() {
            std::net::IpAddr::V4(ip) => Some(ip),
            std::net::IpAddr::V6(_) => None,
        })
        .filter(|ip| !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified())
        .collect();
    // Private ranges first: those are the ones others on the network can use.
    found.sort_by_key(|ip| (!ip.is_private(), *ip));
    found.dedup();
    found.into_iter().map(|ip| ip.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    fn local_addr(port: u16) -> std::net::SocketAddr {
        (Ipv4Addr::LOCALHOST, port).into()
    }

    async fn health(port: u16) -> io::Result<String> {
        let mut s = TcpStream::connect(local_addr(port)).await?;
        s.write_all(b"GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            .await?;
        let mut out = String::new();
        s.read_to_string(&mut out).await?;
        Ok(out)
    }

    #[tokio::test]
    async fn starts_once_serves_and_stops() {
        let host = Host::default();
        let first = host.start(Some(0), None).await.unwrap();
        assert_ne!(first.port, 0);
        assert!(health(first.port).await.unwrap().ends_with("ok"));

        // Asking again returns the running relay, whatever port is asked for.
        let again = host.start(Some(1), None).await.unwrap();
        assert_eq!(again.port, first.port);

        host.stop().await;
        assert!(TcpStream::connect(local_addr(first.port)).await.is_err());
        host.stop().await; // harmless when not hosting

        let restarted = host.start(Some(0), None).await.unwrap();
        assert!(health(restarted.port).await.unwrap().ends_with("ok"));
        host.stop().await;
    }

    #[tokio::test]
    async fn falls_back_to_a_free_port_when_the_wanted_one_is_taken() {
        let taken = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await.unwrap();
        let taken_port = taken.local_addr().unwrap().port();
        let host = Host::default();
        let info = host.start(Some(taken_port), None).await.unwrap();
        assert_ne!(info.port, taken_port);
        assert!(health(info.port).await.unwrap().ends_with("ok"));
        host.stop().await;
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    #[tokio::test]
    async fn kept_rooms_come_back_on_their_port_and_are_kept_again_on_stop() {
        use crate::hosted_rooms::tests::{sample, TempDir};
        let dir = TempDir::new("host");
        // A free port to stand for the one the room was hosted on.
        let free = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);
        let kept = sample(now_ms());
        hosted_rooms::write(&dir.0, port, &kept).unwrap();

        let host = Host::default();
        assert_eq!(host.rooms().await, 0);
        let info = host.start(None, Some(&dir.0)).await.unwrap();
        assert_eq!(info.port, port, "the port people's links carry");
        assert_eq!(host.rooms().await, 1);
        assert!(health(port).await.unwrap().ends_with("ok"));

        // Stopping writes the rooms as they are now; nothing changed, so the same rooms.
        std::fs::remove_file(hosted_rooms::path(&dir.0)).unwrap();
        host.stop().await;
        let Found::Rooms(file) = hosted_rooms::read(&dir.0) else {
            panic!("the rooms were not kept")
        };
        assert_eq!(file.port, port);
        assert_eq!(file.relay, kept);

        // Quitting writes them too, while the relay goes on.
        host.start(None, Some(&dir.0)).await.unwrap();
        std::fs::remove_file(hosted_rooms::path(&dir.0)).unwrap();
        host.keep_now().await;
        assert!(matches!(hosted_rooms::read(&dir.0), Found::Rooms(_)));
        assert_eq!(host.rooms().await, 1);
        host.stop().await;

        // Without a folder nothing is read and nothing is written.
        let other = Host::default();
        other.start(Some(0), None).await.unwrap();
        assert_eq!(other.rooms().await, 0);
        other.stop().await;
    }

    #[tokio::test]
    async fn rooms_that_lapsed_are_dropped_from_the_file() {
        use crate::hosted_rooms::tests::{sample, TempDir};
        let dir = TempDir::new("lapsed");
        // Last used 40 days ago: past the 30 days a room and its members are kept.
        let old = now_ms() - 40 * 86_400_000;
        let mut kept = sample(old);
        kept.tombstones.clear();
        hosted_rooms::write(&dir.0, 0, &kept).unwrap();
        let host = Host::default();
        host.start(Some(0), Some(&dir.0)).await.unwrap();
        assert_eq!(host.rooms().await, 0);
        host.stop().await;
        assert_eq!(hosted_rooms::read(&dir.0), Found::Nothing);
    }

    #[tokio::test]
    async fn a_file_from_a_newer_app_is_left_alone() {
        use crate::hosted_rooms::tests::TempDir;
        let dir = TempDir::new("newer-host");
        std::fs::create_dir_all(&dir.0).unwrap();
        let newer = br#"{"format":99,"port":8787,"relay":{"version":1}}"#;
        std::fs::write(hosted_rooms::path(&dir.0), newer).unwrap();
        let host = Host::default();
        host.start(Some(0), Some(&dir.0)).await.unwrap();
        assert_eq!(host.rooms().await, 0);
        host.stop().await;
        assert_eq!(
            std::fs::read(hosted_rooms::path(&dir.0)).unwrap(),
            newer.to_vec()
        );
    }

    #[test]
    fn listens_on_this_computer_only_when_there_is_no_network_to_share_with() {
        assert_eq!(bind_address(&[]), Ipv4Addr::LOCALHOST);
        assert_eq!(
            bind_address(&["192.168.1.20".to_owned()]),
            Ipv4Addr::UNSPECIFIED
        );
    }

    #[test]
    fn lan_addresses_are_never_loopback() {
        for addr in lan_addresses() {
            let ip: Ipv4Addr = addr.parse().expect("an IPv4 address");
            assert!(!ip.is_loopback());
        }
    }
}
