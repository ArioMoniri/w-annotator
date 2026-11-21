//! The room relay for W Annotator.
//!
//! It speaks two protocols on one port:
//!
//! * **v2** at `/v2/rooms/<ID>`: rooms with a record, member keys, roles,
//!   invites, a total order for edits and the view-through-host rules. The wire
//!   format is written down in `docs/design/ROOMS-PROTOCOL.md`.
//! * **v1** at `/r/<CODE>?name=`: the original dumb relay, for apps that have
//!   not moved yet. Off by default; `RelayConfig::v1` turns it on.
//!
//! The relay keeps everything in memory, never looks inside a payload and
//! writes no logs.

use std::future::Future;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::Path;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::watch;

pub mod auth;
mod conn;
pub mod faults;
pub mod invites;
pub mod limits;
pub mod proto;
pub mod rooms;
mod v1;

pub use faults::Faults;
pub use limits::{Limits, Timing};
pub use rooms::{normalize_room_id, Role, RoomInfo, RoomType};
pub use v1::{
    normalize_name, normalize_room, CLOSE_ROOM_FULL, IDLE_TIMEOUT, MAX_MESSAGE_BYTES,
    MAX_NAME_CHARS, MAX_PEERS_PER_ROOM, PING_INTERVAL,
};

/// How a relay is set up. `Default` is the standalone relay.
#[derive(Debug, Clone, Default)]
pub struct RelayConfig {
    /// Whether protocol v1 (`/r/<CODE>`) is served. Off unless asked for: it
    /// then answers HTTP 426 so an old app tells its user to update.
    pub v1: bool,
    pub limits: Limits,
    pub timing: Timing,
    /// Fault-injection hooks, for tests only. `None` in every real relay.
    pub faults: Option<Faults>,
}

impl RelayConfig {
    /// For the relay inside the desktop app: one person's rooms on a local
    /// network, so far fewer rooms and connections than a room server.
    pub fn embedded() -> Self {
        let mut config = RelayConfig::default();
        config.limits.max_rooms = 8;
        config.limits.max_connections = 128;
        config
    }
}

pub(crate) struct Shared {
    pub cfg: RelayConfig,
    pub v1: v1::Rooms,
    pub v2: Mutex<rooms::V2>,
    pub shutdown: watch::Receiver<bool>,
    /// Open v2 connections.
    pub connections: AtomicUsize,
    pub next_conn: AtomicU64,
    pub ips: Mutex<limits::IpLimiter>,
}

impl Shared {
    /// Milliseconds since the Unix epoch, plus whatever a test moved the clock by.
    pub fn now_ms(&self) -> u64 {
        let real = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        real.saturating_add(self.cfg.faults.as_ref().map_or(0, Faults::clock_offset_ms))
    }
}

pub(crate) type AppState = Arc<Shared>;

/// Counts for a status line. No ids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RelayStats {
    /// Protocol v2 rooms held, connected or dormant.
    pub rooms: usize,
    /// Open protocol v2 connections.
    pub connections: usize,
    /// Protocol v1 rooms with at least one peer.
    pub v1_rooms: usize,
}

/// A relay and a handle to it. Cloning gives another handle to the same relay.
///
/// ```no_run
/// # async fn demo() -> std::io::Result<()> {
/// let relay = w_relay::Relay::new(w_relay::RelayConfig::embedded());
/// let listener = tokio::net::TcpListener::bind("192.168.1.20:8787").await?;
/// let handle = relay.clone();
/// tokio::spawn(async move { relay.serve(listener, std::future::pending()).await });
/// println!("{} rooms", handle.stats().rooms);
/// # Ok(()) }
/// ```
#[derive(Clone)]
pub struct Relay {
    shared: AppState,
    stop: Arc<watch::Sender<bool>>,
}

impl Relay {
    pub fn new(config: RelayConfig) -> Self {
        let (stop, shutdown) = watch::channel(false);
        let ips = limits::IpLimiter::new(config.limits.joins_per_minute);
        let faults = config.faults.clone();
        let shared = Arc::new(Shared {
            cfg: config,
            v1: Mutex::default(),
            v2: Mutex::default(),
            shutdown,
            connections: AtomicUsize::new(0),
            next_conn: AtomicU64::new(1),
            ips: Mutex::new(ips),
        });
        if let Some(faults) = faults {
            faults.attach(&shared);
        }
        Relay {
            shared,
            stop: Arc::new(stop),
        }
    }

    /// Serves on `listener` until `shutdown` resolves, then closes every
    /// connection and returns. A relay is served once.
    pub async fn serve(
        &self,
        listener: TcpListener,
        shutdown: impl Future<Output = ()> + Send + 'static,
    ) -> std::io::Result<()> {
        let app = Router::new()
            .route("/health", get(health))
            .route("/r/{room}", get(v1::join))
            .route("/v2/rooms/{room}", get(conn::connect))
            .route("/j/{room}", get(invite_page))
            .with_state(self.shared.clone());

        let sweeper = tokio::spawn(sweep_loop(self.shared.clone()));
        let stop = self.stop.clone();
        let served = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            shutdown.await;
            // Tell the websocket tasks, which outlive the HTTP connections.
            let _ = stop.send(true);
        })
        .await;
        sweeper.abort();
        served
    }

    pub fn stats(&self) -> RelayStats {
        RelayStats {
            rooms: rooms::count(&self.shared),
            connections: self.shared.connections.load(Ordering::Relaxed),
            v1_rooms: self.shared.v1.lock().unwrap().len(),
        }
    }

    /// The v2 rooms this relay holds, sorted by id.
    pub fn rooms(&self) -> Vec<RoomInfo> {
        rooms::list(&self.shared)
    }

    /// Deletes a v2 room as its host would: everyone is closed with 4410.
    /// Returns whether there was such a room.
    pub fn delete_room(&self, id: &str) -> bool {
        match normalize_room_id(id) {
            Some(id) => rooms::delete_room(&self.shared, &id),
            None => false,
        }
    }
}

/// Runs a relay with the default configuration on `listener` until `shutdown`
/// resolves, then closes every connection and returns.
pub async fn serve(
    listener: TcpListener,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    Relay::new(RelayConfig::default())
        .serve(listener, shutdown)
        .await
}

async fn sweep_loop(shared: AppState) {
    let every = shared.cfg.timing.sweep_interval;
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
    loop {
        tick.tick().await;
        rooms::sweep(&shared);
    }
}

async fn health() -> impl IntoResponse {
    ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], "ok")
}

const INVITE_PAGE: &str = "<!doctype html>
<html lang=\"en\">
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
<title>W Annotator room</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.5rem;color:#1c1c1e;background:#fff}@media(prefers-color-scheme:dark){body{color:#eee;background:#161618}}</style>
<h1>This is a room link</h1>
<p>Open W Annotator, choose Join a room and paste this link.</p>
<p>The link works once and only for a limited time. If it has expired, ask the host for a new one.</p>
</html>
";

/// The page an invite link opens in a browser. It is the same for every id and
/// reads nothing: the secret in the link's fragment never reaches the relay.
async fn invite_page(Path(room): Path<String>) -> Response {
    if normalize_room_id(&room).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'unsafe-inline'",
            ),
        ],
        INVITE_PAGE,
    )
        .into_response()
}
