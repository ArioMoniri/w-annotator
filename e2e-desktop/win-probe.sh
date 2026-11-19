#!/usr/bin/env bash
# Temporary: finds out why msedgedriver cannot start a session with the app on the Windows runner.
set -u
APP="$PWD/target/debug/w-annotator.exe"
stop() { taskkill //IM w-annotator.exe //T //F > /dev/null 2>&1; sleep 3; }
poll() {
  for i in $(seq 1 20); do
    out=$(curl -s -m 2 "http://127.0.0.1:$1/json/version") && [ -n "$out" ] && { echo "devtools on $1: ${out:0:120}"; return 0; }
    sleep 2
  done
  echo "no devtools endpoint on $1 after 40 s"
}
switches() {
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='msedgewebview2.exe'\" | Where-Object { \$_.CommandLine -notmatch '--type=' } | ForEach-Object { \$_.CommandLine }" \
    | tr ' ' '\n' | grep -i "remote-debugging\|user-data-dir\|webview-exe-name\|enable-automation" | tr '\n' ' '
  echo
}

echo "== A. env args, default data folder"
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333" "$APP" &
poll 9333
switches
stop

echo "== B. env args and env data folder"
UDF=$(cygpath -w "$RUNNER_TEMP/udf-$$")
WEBVIEW2_USER_DATA_FOLDER="$UDF" WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9334" "$APP" &
poll 9334
switches
ls "$RUNNER_TEMP/udf-$$/EBWebView" 2>&1 | grep -i devtools
stop
