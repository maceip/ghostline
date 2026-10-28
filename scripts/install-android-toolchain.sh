#!/usr/bin/env bash
# Install a JDK + Android SDK so the Android client can actually be COMPILED
# and verified locally, rather than only asserted statically.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive

log() { echo "[$(date +%H:%M:%S)] $*"; }

log "=== apt update ==="
apt-get update -qq 2>&1 | tail -3 || { log "apt update failed"; exit 1; }

log "=== install JDK 17 ==="
apt-get install -y -qq openjdk-17-jdk-headless unzip >/dev/null 2>&1 || {
  apt-get install -y -qq openjdk-17-jdk-headless unzip || { log "JDK install failed"; exit 1; }
}
export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(which javac)")")")"
log "JAVA_HOME=$JAVA_HOME"
java -version 2>&1 | head -2

SDK=/opt/android-sdk
mkdir -p "$SDK/cmdline-tools"

log "=== download Android command-line tools ==="
cd /tmp
URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
if curl -sSL -o cmdtools.zip "$URL"; then
  log "downloaded $(du -h cmdtools.zip | cut -f1)"
  unzip -q -o cmdtools.zip -d /tmp/cmdtools-extract
  mv /tmp/cmdtools-extract/cmdline-tools "$SDK/cmdline-tools/latest"
else
  log "cmdline-tools download failed"
  exit 1
fi

export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"

log "=== accept licences ==="
yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1 || true

log "=== install platform 36 + build-tools ==="
"$SDK/cmdline-tools/latest/bin/sdkmanager" --install "platform-tools" "platforms;android-36" "build-tools;36.0.0" 2>&1 | tail -5

log "=== install gradle 8.11.1 ==="
cd /tmp
curl -sSL -o gradle.zip "https://services.gradle.org/distributions/gradle-8.11.1-bin.zip" || { log "gradle download failed"; exit 1; }
unzip -q -o gradle.zip -d /opt
ln -sf /opt/gradle-8.11.1/bin/gradle /usr/local/bin/gradle
gradle --version 2>&1 | head -6

log "=== DONE — toolchain ready ==="
