#!/usr/bin/env bash
# Safful-Md restart loop (LF endings — do not convert to CRLF).
# Runs the bot forever, restarting with a short pause so instant-fail boots
# cannot hot-loop the CPU or hammer WhatsApp's login endpoint.
# --expose-gc activates the memory-watchdog tiers in index.js (500/650 MB trim).
export NODE_OPTIONS="${NODE_OPTIONS} --expose-gc"
while true
do
echo "Starting Safful-Md!"
node .
code=$?
echo "Safful-Md exited with code ${code} — restarting in 3s"
sleep 3
done
