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

  enterShell = ''
    echo "Product CLI: videbug (build first with npm run build)."
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
