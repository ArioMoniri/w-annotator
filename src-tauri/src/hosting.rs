//! Hosting a room on the local network with the embedded relay.

use std::io;
use std::net::Ipv4Addr;
use std::time::Duration;

use serde::Serialize;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

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

struct Running {
    port: u16,
    stop: oneshot::Sender<()>,
    task: JoinHandle<io::Result<()>>,
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
    pub async fn start(&self, port: Option<u16>) -> io::Result<HostInfo> {
        let mut slot = self.0.lock().await;
        if let Some(running) = slot.as_ref() {
            if !running.task.is_finished() {
                return Ok(info(running.port));
            }
        }
        let wanted = port.unwrap_or(DEFAULT_PORT);
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
        let task = tokio::spawn(async move {
            relay
                .serve(listener, async {
                    let _ = stopped.await;
                })
                .await
        });
        *slot = Some(Running { port, stop, task });
        Ok(info(port))
    }

    /// Stops the relay and waits until its port is free. Does nothing if not hosting.
    pub async fn stop(&self) {
        let Some(running) = self.0.lock().await.take() else {
            return;
        };
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
        let first = host.start(Some(0)).await.unwrap();
        assert_ne!(first.port, 0);
        assert!(health(first.port).await.unwrap().ends_with("ok"));

        // Asking again returns the running relay, whatever port is asked for.
        let again = host.start(Some(1)).await.unwrap();
        assert_eq!(again.port, first.port);

        host.stop().await;
        assert!(TcpStream::connect(local_addr(first.port)).await.is_err());
        host.stop().await; // harmless when not hosting

        let restarted = host.start(Some(0)).await.unwrap();
        assert!(health(restarted.port).await.unwrap().ends_with("ok"));
        host.stop().await;
    }

    #[tokio::test]
    async fn falls_back_to_a_free_port_when_the_wanted_one_is_taken() {
        let taken = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await.unwrap();
        let taken_port = taken.local_addr().unwrap().port();
        let host = Host::default();
        let info = host.start(Some(taken_port)).await.unwrap();
        assert_ne!(info.port, taken_port);
        assert!(health(info.port).await.unwrap().ends_with("ok"));
        host.stop().await;
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
