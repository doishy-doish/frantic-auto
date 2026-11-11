#!/usr/bin/env bash
# audit-sweep.sh <owner/repo> <ref> <stamp>
# Clones target (public), runs forge build + aderyn + slither (each best-effort),
# drops JSON/logs under evidence/<stamp>/. Stdout: one line per tool. No bodies.
set -u
REPO="$1"; REF="${2:-}"; STAMP="$3"; SOLC_VER="${4:-0.8.19}"
EV="evidence/$STAMP"
mkdir -p "$EV"
echo "boot repo=$REPO ref=${REF:-default} stamp=$STAMP"

# --- clone (public, no auth) ---
rm -rf sweep-target
if [ -n "$REF" ]; then
  git clone --quiet "https://github.com/$REPO.git" sweep-target 2>"$EV/clone.log" \
    && git -C sweep-target fetch --quiet --depth 1 origin "$REF" >>"$EV/clone.log" 2>&1 \
    && git -C sweep-target checkout --quiet FETCH_HEAD >>"$EV/clone.log" 2>&1 \
    && echo "clone ok $(git -C sweep-target rev-parse --short HEAD)" || echo "clone FAIL (see evidence)"
else
  git clone --quiet --depth 1 "https://github.com/$REPO.git" sweep-target 2>"$EV/clone.log" \
    && echo "clone ok" || echo "clone FAIL (see evidence)"
fi
echo "{\"repo\":\"$REPO\",\"ref\":\"$REF\",\"sha\":\"$(git -C sweep-target rev-parse HEAD 2>/dev/null || echo unknown)\",\"at\":\"$(date -u +%FT%TZ)\"}" > "$EV/meta.json"

export PATH="$HOME/.foundry/bin:$HOME/.cyfrin/bin:$PATH"

# --- foundry (binary, no apt) ---
if ! command -v forge >/dev/null; then
  curl -sSL https://foundry.paradigm.xyz 2>/dev/null | bash >/dev/null 2>&1 || true
  "$HOME/.foundry/bin/foundryup" >/dev/null 2>&1 || true
fi
echo "forge: $(forge --version 2>/dev/null || echo MISSING)"

# --- aderyn (pinned binary, no apt) ---
if ! command -v aderyn >/dev/null; then
  AVER="aderyn-v0.6.8"
  mkdir -p "$HOME/.cyfrin/bin"
  curl -sSL -o /tmp/aderyn.tar.xz "https://github.com/Cyfrin/aderyn/releases/download/$AVER/aderyn-x86_64-unknown-linux-gnu.tar.xz" >/dev/null 2>&1 || true
  tar -xJf /tmp/aderyn.tar.xz -C "$HOME/.cyfrin/bin" >/dev/null 2>&1 || true
  chmod +x "$HOME/.cyfrin/bin/"* >/dev/null 2>&1 || true
fi
echo "aderyn: $(aderyn --version 2>/dev/null || echo MISSING)"

# --- slither (best-effort, needs pip; no apt) ---
if ! command -v slither >/dev/null; then
  python3 -m pip install --quiet --user slither-analyzer solc-select 2>>"$EV/install.log" || echo "pip FAIL" >>"$EV/install.log"
  export PATH="$HOME/.local/bin:$PATH"
fi
if command -v solc-select >/dev/null; then
  solc-select install "$SOLC_VER" >>"$EV/install.log" 2>&1 || true
  solc-select use "$SOLC_VER" >>"$EV/install.log" 2>&1 || true
fi
echo "slither: $(slither --version 2>/dev/null || echo MISSING)"

cd sweep-target || exit 0

# --- forge deps + build ---
[ -f foundry.toml ] && forge install --no-commit --quiet >/dev/null 2>&1 || true
forge build --force >"../$EV/forge-build.log" 2>&1 && echo "forge-build: OK" || echo "forge-build: FAIL (see log)"

# --- aderyn ---
aderyn --output "../$EV/aderyn.json" . >"../$EV/aderyn.log" 2>&1 && echo "aderyn: OK" || echo "aderyn: FAIL (see log)"

# --- slither (needs solc matching pragma; try solc-select auto) ---
if command -v slither >/dev/null; then
  export PATH="$HOME/.local/bin:$PATH"
  slither . --json "../$EV/slither.json" >"../$EV/slither.log" 2>&1 && echo "slither: OK" || echo "slither: FAIL (see log)"
else
  echo "slither: SKIPPED"
fi

# --- trim evidence (keep JSONs + tails only) ---
cd ..
for f in forge-build aderyn slither; do
  if [ -f "$EV/$f.log" ]; then tail -c 4000 "$EV/$f.log" > "$EV/$f.log.tmp" && mv "$EV/$f.log.tmp" "$EV/$f.log"; fi
done
ls -la "$EV"
echo "done stamp=$STAMP"
