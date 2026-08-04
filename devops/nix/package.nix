{
  lib,
  stdenv,
  bun,
  cacert,
  reactions,
}:

let
  pkg = builtins.fromJSON (builtins.readFile ../../package.json);
  bunDeps = import ./bun-deps.nix {
    inherit
      lib
      stdenv
      bun
      cacert
      ;
  };
in
stdenv.mkDerivation {
  inherit (pkg) name version;
  src = lib.cleanSourceWith {
    src = ../../.;
    filter =
      name: type:
      let
        baseName = baseNameOf (toString name);
      in
      !(
        type == "directory"
        && (
          baseName == "node_modules"
          || baseName == ".cache"
          || baseName == ".devenv"
          || baseName == ".git"
          || baseName == ".next"
          || baseName == "out"
        )
      )
      && !(lib.hasInfix "/public/reactions" (toString name))
      && !(lib.hasInfix "/public/rdkit" (toString name));
  };
  # Bun's compiled executable contains the application in embedded sections;
  # the generic Nix strip phase removes those sections.
  dontStrip = true;
  dontPatchELF = true;
  nativeBuildInputs = [ bun ];
  buildInputs = [ cacert ];
  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    export NEXT_TELEMETRY_DISABLED=1
    cp -r --no-preserve=mode ${bunDeps}/node_modules node_modules
    mkdir -p public/reactions
    cp -r ${reactions}/* public/reactions/
    bun run devops/scripts/copy-rdkit.ts
    bun node_modules/next/dist/bin/next build
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/out
    cp -r out/* $out/out/
    bun build --compile --minify --outfile dist/electron-server devops/scripts/server.ts
    cp dist/electron-server $out/bin/electron-server
    runHook postInstall
  '';
  meta = {
    description = "Electron - reaction explorer static site and API server";
    homepage = "https://github.com/kk-spartans/electron";
    license = lib.licenses.unlicense;
    mainProgram = "electron-server";
  };
}
