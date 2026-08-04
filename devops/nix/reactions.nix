{
  lib,
  stdenv,
  bun,
  cacert,
}:

let
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
  # Keep this output stable across app releases. The fixed-output hash already
  # captures the generated index, and the source only contains its true inputs.
  name = "electron-reactions";
  src = lib.sourceByRegex ../../. [
    "^devops$"
    "^devops/scripts$"
    "^devops/scripts/build-reaction-index\\.ts$"
    "^devops/scripts/ord-index-worker\\.ts$"
    "^devops/snapshots$"
    "^devops/snapshots/.*$"
  ];
  dontStrip = true;
  dontPatchELF = true;
  nativeBuildInputs = [ bun ];
  buildInputs = [ cacert ];
  outputHashAlgo = "sha256";
  outputHashMode = "recursive";
  outputHash = "sha256-3R/DAta6S0ChSIDAlKdmXDOQOHBy3AuFw+IFEeWb7aY=";
  buildPhase = ''
    export HOME=$TMPDIR
    export SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt
    cp -r --no-preserve=mode ${bunDeps}/node_modules node_modules
    bun devops/scripts/build-reaction-index.ts
  '';
  installPhase = ''
    mkdir -p $out
    cp -r public/reactions/* $out/
  '';
  meta = {
    description = "Static reaction index for electron";
    license = lib.licenses.unlicense;
  };
}
