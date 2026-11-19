#!/usr/bin/env bash
# Temporary: finds out why msedgedriver cannot start a session with the app on the Windows runner.
set -u
APP="$PWD/target/debug/w-annotator.exe"
DRIVER="$W_NATIVE_DRIVER"

echo "== driver version"
"$DRIVER" --version

echo "== 1. does the app honour WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS?"
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333" "$APP" &
sleep 20
curl -s -m 5 http://127.0.0.1:9333/json/version || echo "no devtools endpoint on 9333"
echo
tasklist | grep -i "w-annotator\|webview" || true
taskkill //IM w-annotator.exe //T //F > /dev/null 2>&1
sleep 3

echo "== 2. msedgedriver directly, verbose"
"$DRIVER" --port=9515 --verbose --log-path="$RUNNER_TEMP/msedgedriver.log" &
sleep 3
BIN=$(cygpath -w "$APP" | sed 's/\\/\\\\/g')
curl -s -m 90 -X POST http://127.0.0.1:9515/session -H 'Content-Type: application/json' \
  -d "{\"capabilities\":{\"alwaysMatch\":{\"browserName\":\"webview2\",\"ms:edgeChromium\":true,\"ms:edgeOptions\":{\"binary\":\"$BIN\",\"args\":[]}}}}" | cut -c1-600
echo
taskkill //IM w-annotator.exe //T //F > /dev/null 2>&1
taskkill //IM msedgedriver.exe //T //F > /dev/null 2>&1
echo "== driver log (launch and errors)"
grep -n -i "launch\|DevToolsActivePort\|user-data\|WEBVIEW2\|error\|exit" "$RUNNER_TEMP/msedgedriver.log" | cut -c1-700 | head -40
