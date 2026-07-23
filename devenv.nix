{ pkgs, lib, ... }:

{
  env.LD_LIBRARY_PATH = lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];

  # The Pi SDK (@earendil-works/pi-coding-agent) is a normal, exact-pinned npm
  # dependency (see package.json and docs/adr/0001-m0-contracts-and-spikes.md).
  # `npm install` restores it from the public registry into node_modules.

  packages = [
    pkgs.ffmpeg
    # Node.js runtime for the videbug CLI and Pi SDK (SDK documents Node >=22.19).
    pkgs.nodejs_22
    pkgs.stdenv.cc.cc.lib
  ];

  scripts.videbug.exec = ''
    set -euo pipefail
    npm --prefix "$DEVENV_ROOT" run build --silent
    exec node "$DEVENV_ROOT/dist/cli.js" "$@"
  '';

  scripts.install-local.exec = ''
    set -euo pipefail
    install_prefix="$HOME/.local"
    npm install \
      --global \
      --prefix "$install_prefix" \
      --package-lock=false \
      --audit=false \
      "$DEVENV_ROOT"
    install_path="$install_prefix/bin/videbug"
    echo "Installed latest checkout to $install_path"
    "$install_path" --version
    resolved="$(command -v videbug || true)"
    if [ "$resolved" != "$install_path" ]; then
      echo "Within this devenv, videbug intentionally resolves to the checkout runner: ''${resolved:-not found}"
      echo "Outside the devenv, ensure $install_prefix/bin precedes other entries in PATH."
    fi
  '';

  enterShell = ''
    echo "Product CLI: videbug (automatically builds and runs this checkout)."
    echo "Install this checkout locally with: install-local"
  '';

  enterTest = ''
    ffmpeg -version | head -n1

    # videbug Node/TypeScript package: restore deps and run the full gate.
    # `npm install` is a no-op when the lockfile is already satisfied; it does not
    # re-hit the registry age policy for already-installed, pinned packages.
    npm install
    npm run typecheck
    npm run lint
    npm test
    npm run build
    test -f dist/cli.js
  '';
}
