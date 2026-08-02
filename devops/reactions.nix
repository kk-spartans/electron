{
  lib,
  stdenv,
  bun,
  cacert,
}:

let
  pkg = builtins.fromJSON (builtins.readFile ../package.json);
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
  name = "${pkg.name}-reactions-${pkg.version}";
  src = lib.cleanSourceWith {
    src = ../.;
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
          || baseName == "public"
        )
      );
  };
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
    bun run devops/build-reaction-index.ts
  '';
  installPhase = ''
    mkdir -p $out
    cp -r public/reactions/* $out/
  '';
  meta = {
    description = "Static reaction index for ${pkg.name}";
    license = lib.licenses.unlicense;
  };
}
