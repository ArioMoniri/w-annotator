//! Accepting connections so that one which never finishes its request cannot
//! be held open for ever, and so that only a bounded number are open at once.
//!
//! The HTTP layer has no time limit of its own for reading a request. Without
//! one, anybody who can reach the port could open sockets, send nothing, and
//! keep every one of them until the relay ran out of file descriptors.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::serve::Listener;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Sleep;

/// A TCP listener whose connections must send a whole request header within
/// `timeout`, and which holds at most `slots` connections at a time.
pub(crate) struct Guarded {
    inner: TcpListener,
    timeout: Duration,
    slots: Arc<Semaphore>,
}

impl Guarded {
    pub fn new(inner: TcpListener, timeout: Duration, slots: usize) -> Self {
        Guarded {
            inner,
            timeout,
            slots: Arc::new(Semaphore::new(slots)),
        }
    }
}

impl Listener for Guarded {
    type Io = Deadline;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Deadline, SocketAddr) {
        // With every place taken, new connections wait in the kernel's queue.
        let slot = self
            .slots
            .clone()
            .acquire_owned()
            .await
            .expect("the semaphore is never closed");
        let (stream, addr) = Listener::accept(&mut self.inner).await;
        let io = Deadline {
            stream,
            deadline: Some(Box::pin(tokio::time::sleep(self.timeout))),
            matched: 0,
            _slot: slot,
        };
        (io, addr)
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.inner.local_addr()
    }
}

/// A connection that fails with `TimedOut` if the first request's header has
/// not arrived in full when the deadline passes. After the header there is no
/// deadline here: a websocket has its own liveness rules, and every other
/// answer closes the connection.
pub(crate) struct Deadline {
    stream: TcpStream,
    deadline: Option<Pin<Box<Sleep>>>,
    /// How much of the blank line that ends a header the bytes so far end with.
    matched: u8,
    _slot: OwnedSemaphorePermit,
}

/// Advances the search for `\r\n\r\n` by one byte.
fn step(matched: u8, byte: u8) -> u8 {
    match (matched, byte) {
        (0 | 2, b'\r') | (1 | 3, b'\n') => matched + 1,
        (_, b'\r') => 1,
        _ => 0,
    }
}

impl AsyncRead for Deadline {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = &mut *self;
        if let Some(deadline) = this.deadline.as_mut() {
            if deadline.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
            }
        }
        let before = buf.filled().len();
        let poll = Pin::new(&mut this.stream).poll_read(cx, buf);
        if this.deadline.is_some() && matches!(poll, Poll::Ready(Ok(()))) {
            for &byte in &buf.filled()[before..] {
                this.matched = step(this.matched, byte);
                if this.matched == 4 {
                    this.deadline = None;
                    break;
                }
            }
        }
        poll
    }
}

impl AsyncWrite for Deadline {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }
}

#[cfg(test)]
mod tests {
    use super::step;

    fn ends_header(bytes: &[u8]) -> bool {
        let mut matched = 0;
        for &b in bytes {
            matched = step(matched, b);
            if matched == 4 {
                return true;
            }
        }
        false
    }

    #[test]
    fn the_blank_line_that_ends_a_header_is_found_wherever_it_falls() {
        assert!(ends_header(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
        assert!(ends_header(b"\r\n\r\n"));
        assert!(ends_header(b"a\r\r\n\r\nb"));
        assert!(ends_header(b"a\r\n\r\r\n\r\n"));
        assert!(!ends_header(b"GET / HTTP/1.1\r\nHost: x\r\n"));
        assert!(!ends_header(b"\r\n\r"));
        assert!(!ends_header(b"\n\n\n\n"));
        assert!(!ends_header(b"\r\n \r\n"));
        assert!(!ends_header(b""));
    }
}
