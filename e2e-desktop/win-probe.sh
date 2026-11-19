#!/usr/bin/env bash
# Temporary: finds out why msedgedriver cannot start a session with the app on the Windows runner.
set -u
APP="$PWD/target/debug/w-annotator.exe"
UDF_DEFAULT="$LOCALAPPDATA/com.wannotator.app/EBWebView"
stop() { taskkill //IM w-annotator.exe //T //F > /dev/null 2>&1; sleep 3; }
poll() { for i in $(seq 1 15); do curl -s -m 2 "http://127.0.0.1:$1/json/version" | head -c 200 && return 0; sleep 2; done; echo "no devtools endpoint on $1"; }

echo "== A. env args, default data folder"
tasklist | grep -ci "webview" || true
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333" "$APP" &
poll 9333; echo
ls "$UDF_DEFAULT" 2>&1 | head -20 | tr '\n' ' '; echo
cat "$UDF_DEFAULT/DevToolsActivePort" 2>&1 | head -2
stop

echo "== B. env args and env data folder"
UDF=$(cygpath -w "$RUNNER_TEMP/udf-b")
WEBVIEW2_USER_DATA_FOLDER="$UDF" WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9334" "$APP" &
poll 9334; echo
ls "$RUNNER_TEMP/udf-b" 2>&1 | head -20 | tr '\n' ' '; echo
cat "$RUNNER_TEMP/udf-b/DevToolsActivePort" 2>&1 | head -2
stop

if [ -n "${W_NATIVE_DRIVER:-}" ]; then
  echo "== C. msedgedriver directly, verbose"
  "$W_NATIVE_DRIVER" --port=9515 --verbose --log-path="$RUNNER_TEMP/msedgedriver.log" > /dev/null 2>&1 &
  sleep 3
  BIN=$(cygpath -w "$APP" | sed 's/\\/\\\\/g')
  curl -s -m 90 -X POST http://127.0.0.1:9515/session -H 'Content-Type: application/json' \
    -d "{\"capabilities\":{\"alwaysMatch\":{\"browserName\":\"webview2\",\"ms:edgeChromium\":true,\"ms:edgeOptions\":{\"binary\":\"$BIN\",\"args\":[]}}}}" | cut -c1-160
  echo
  stop
  taskkill //IM msedgedriver.exe //T //F > /dev/null 2>&1
  grep -n -i "WEBVIEW2\|Launching\|user.data\|DevToolsActivePort" "$RUNNER_TEMP/msedgedriver.log" | cut -c1-260 | head -12
fi
