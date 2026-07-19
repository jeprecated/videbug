{
  lib,
  stdenv,
  buildNpmPackage,
  nodejs_22,
  ffmpeg-headless,
  makeWrapper,
  autoPatchelfHook,
}:

buildNpmPackage (finalAttrs: {
  pname = "videbug";
  version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

  src = lib.cleanSourceWith {
    src = ./.;
    filter =
      path: type:
      let
        root = toString ./.;
        absolute = toString path;
        relative = lib.removePrefix "${root}/" absolute;
        topLevel = builtins.head (lib.splitString "/" relative);
      in
      absolute == root
      || builtins.elem topLevel [
        "LICENSE"
        "README.md"
        "assets"
        "package-lock.json"
        "package.json"
        "schema"
        "src"
        "tsconfig.build.json"
        "tsconfig.json"
      ];
  };

  nodejs = nodejs_22;
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-q29f5bWXx7c/wrrg/jKwDMb6UXIGTVToPB7fV6QXLak=";

  nativeBuildInputs = [
    makeWrapper
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];

  # buildNpmPackage installs the package.json files allowlist and creates both bin
  # wrappers. Add ffmpeg/ffprobe to their runtime PATH without depending on the
  # caller's environment.
  makeWrapperArgs = [
    "--prefix"
    "PATH"
    ":"
    (lib.makeBinPath [ ffmpeg-headless ])
  ];

  # npm retains both glibc and musl canvas optional packages on Linux. The musl
  # binary is unreachable on nixpkgs' glibc systems and cannot be patched there;
  # remove it rather than carrying a dead incompatible native object.
  postInstall = lib.optionalString stdenv.hostPlatform.isLinux ''
    find "$out/lib/node_modules/videbug/node_modules/@napi-rs" \
      -maxdepth 1 -type d -name '*-musl' -exec rm -rf {} +
  '';

  meta = {
    description = "Turn screen recordings into validated, evidence-backed debugging handoffs";
    mainProgram = "videbug";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
})
