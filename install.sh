#!/usr/bin/env bash
set -euo pipefail

# opencode-litellm-costs installer
# Usage: curl -fsSL https://raw.githubusercontent.com/oroszgy/opencode-litellm-costs/master/install.sh | bash
# Or with a specific version: curl -fsSL ... | bash -s -- v0.1.0

REPO="oroszgy/opencode-litellm-costs"
PLUGIN_DIR="${HOME}/.config/opencode/plugins/opencode-litellm-costs"
VERSION="${1:-}"

info() { printf '\033[1;34m%s\033[0m\n' "$1"; }
error() { printf '\033[1;31mError: %s\033[0m\n' "$1" >&2; exit 1; }
success() { printf '\033[1;32m%s\033[0m\n' "$1"; }

# Check prerequisites
command -v bun >/dev/null 2>&1 || error "Bun is required but not installed. Install it from https://bun.sh"
command -v curl >/dev/null 2>&1 || error "curl is required but not installed."

# Resolve version
if [ -z "$VERSION" ]; then
  info "Fetching latest release..."
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
  [ -z "$VERSION" ] && error "Could not determine latest release. Check https://github.com/${REPO}/releases"
fi

info "Installing opencode-litellm-costs ${VERSION}..."

# Create plugin directory
mkdir -p "$PLUGIN_DIR"

# Download and extract release tarball
TARBALL_URL="https://github.com/${REPO}/releases/download/${VERSION}/opencode-litellm-costs-${VERSION}.tar.gz"
info "Downloading ${TARBALL_URL}..."

curl -fsSL "$TARBALL_URL" | tar -xz -C "$PLUGIN_DIR" --strip-components=1

# Install dependencies
info "Installing dependencies..."
(cd "$PLUGIN_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)

success ""
success "opencode-litellm-costs ${VERSION} installed to ${PLUGIN_DIR}"
echo ""
echo "Next steps:"
echo ""
echo "  1. Set your LiteLLM API key:"
echo "     export LITELLM_API_KEY=\"sk-your-key\""
echo ""
echo "  2. (Optional) Set your LiteLLM base URL:"
echo "     export LITELLM_BASE_URL=\"https://your-proxy.example.com\""
echo ""
echo "  3. Register the plugin in ~/.config/opencode/opencode.json:"
echo "     {"
echo "       \"plugin\": ["
echo "         [\"${PLUGIN_DIR}/index.ts\", {}]"
echo "       ]"
echo "     }"
echo ""
echo "  4. Restart OpenCode"
echo ""
echo "For more info: https://github.com/${REPO}"
