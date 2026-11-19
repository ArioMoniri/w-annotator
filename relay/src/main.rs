use std::net::{IpAddr, SocketAddr};
use std::process::ExitCode;

const USAGE: &str = "\
w-relay: room relay for W Annotator

Usage: w-relay [--port <PORT>] [--host <ADDR>] [options]

  --port <PORT>             Port to listen on (default: $PORT, else 8787)
  --host <ADDR>             Address to bind (default: 0.0.0.0)
  --max-rooms <N>           Rooms held at once (default: 1024)
  --joins-per-minute <N>    Connection attempts per address per minute
                            (default: 30; raise it behind a proxy, where
                            every client has the proxy's address)
  --no-v1                   Refuse apps that still use the old protocol
";

struct Options {
    host: IpAddr,
    port: u16,
    config: w_relay::RelayConfig,
}

fn parse(args: &[String], env_port: Option<String>) -> Result<Options, String> {
    let mut host: IpAddr = [0, 0, 0, 0].into();
    let mut port: u16 = match env_port.filter(|p| !p.trim().is_empty()) {
        Some(p) => p
            .trim()
            .parse()
            .map_err(|_| format!("PORT is not a port number: {p}"))?,
        None => 8787,
    };
    let mut config = w_relay::RelayConfig::default();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if arg == "--no-v1" {
            config.v1 = false;
            continue;
        }
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) => (f, Some(v.to_owned())),
            None => (arg.as_str(), None),
        };
        let mut value = || {
            inline
                .clone()
                .or_else(|| it.next().cloned())
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match flag {
            "--port" | "-p" => {
                let v = value()?;
                port = v.parse().map_err(|_| format!("not a port number: {v}"))?;
            }
            "--host" => {
                let v = value()?;
                host = v.parse().map_err(|_| format!("not an IP address: {v}"))?;
            }
            "--max-rooms" => {
                let v = value()?;
                config.limits.max_rooms = v.parse().map_err(|_| format!("not a number: {v}"))?;
            }
            "--joins-per-minute" => {
                let v = value()?;
                config.limits.joins_per_minute =
                    v.parse().map_err(|_| format!("not a number: {v}"))?;
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Options { host, port, config })
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = ctrl_c => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => ctrl_c.await,
        }
    }
    #[cfg(not(unix))]
    ctrl_c.await;
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    let options = match parse(&args, std::env::var("PORT").ok()) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let addr = SocketAddr::new(options.host, options.port);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("could not listen on {addr}: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("w-relay listening on {addr}");
    let relay = w_relay::Relay::new(options.config);
    match relay.serve(listener, shutdown_signal()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("relay stopped: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn defaults_env_and_flags() {
        let o = parse(&[], None).unwrap();
        assert_eq!((o.host.to_string().as_str(), o.port), ("0.0.0.0", 8787));
        assert_eq!(parse(&[], Some("9000".into())).unwrap().port, 9000);
        let o = parse(
            &args(&["--port", "1234", "--host=127.0.0.1"]),
            Some("9000".into()),
        )
        .unwrap();
        assert_eq!((o.host.to_string().as_str(), o.port), ("127.0.0.1", 1234));
        assert!(o.config.v1);
        assert_eq!(o.config.limits.max_rooms, 1024);
        assert!(o.config.faults.is_none());
        let o = parse(
            &args(&["--no-v1", "--max-rooms=10", "--joins-per-minute", "600"]),
            None,
        )
        .unwrap();
        assert!(!o.config.v1);
        assert_eq!(o.config.limits.max_rooms, 10);
        assert_eq!(o.config.limits.joins_per_minute, 600);
        assert!(parse(&args(&["--max-rooms", "many"]), None).is_err());
        assert!(parse(&args(&["--port"]), None).is_err());
        assert!(parse(&args(&["--nope"]), None).is_err());
    }
}
