{
  description = "videbug — evidence-backed debugging handoffs from screen recordings";

  # 26.05 is the latest branch that supports all four declared systems,
  # including x86_64-darwin (removed from nixpkgs unstable/26.11).
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      packageFor = system: nixpkgs.legacyPackages.${system}.callPackage ./package.nix { };
    in
    {
      packages = forAllSystems (system: {
        videbug = packageFor system;
        default = self.packages.${system}.videbug;
      });

      apps = forAllSystems (system: {
        videbug = {
          type = "app";
          program = "${self.packages.${system}.videbug}/bin/videbug";
          meta.description = "Turn screen recordings into validated debugging handoffs";
        };
        default = self.apps.${system}.videbug;
      });

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          videbug = self.packages.${system}.videbug;
        in
        {
          package = videbug;
          cli-smoke = pkgs.runCommand "videbug-cli-smoke" { nativeBuildInputs = [ videbug ]; } ''
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME"
            videbug --version | grep -Fx '0.1.0'
            videbug --help | grep -F 'videbug <video> [options]'
            video-to-debug --version | grep -Fx '0.1.0'
            video-to-debug --help | grep -F 'videbug <video> [options]'
            touch "$out"
          '';
        }
      );

      overlays.default = final: _prev: {
        videbug = final.callPackage ./package.nix { };
      };

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
