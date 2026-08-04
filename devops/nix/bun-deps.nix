{
  lib,
  stdenv,
  bun,
  cacert,
}:

let
  pkg = builtins.fromJSON (builtins.readFile ../../package.json);
  normalizedPackage = builtins.toFile "electron-package.json" (
    builtins.toJSON (pkg // { version = "0.0.0"; })
  );
  dependencySource = stdenv.mkDerivation {
    name = "electron-bun-deps-source";
    dontUnpack = true;
    dontBuild = true;
    installPhase = ''
      mkdir -p $out
      cp ${normalizedPackage} $out/package.json
      cp ${../../bun.lock} $out/bun.lock
    '';
  };
in
stdenv.mkDerivation {
  name = "electron-bun-deps";
  src = dependencySource;
  nativeBuildInputs = [ bun ];
  buildInputs = [ cacert ];
  dontFixup = true;
  dontPatchShebangs = true;
  dontStrip = true;
  outputHashAlgo = "sha256";
  outputHashMode = "recursive";
  outputHash = "sha256-QjFV5NUw6W3r8V9C8DvLALMjG7nfvU2OqOKrNpu5ob4=";
  buildPhase = ''
    export HOME=$TMPDIR
    export SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt
    bun install --no-verify
  '';
  installPhase = ''
    mkdir -p $out/node_modules
    cp -r node_modules/* node_modules/.* $out/node_modules/ 2>/dev/null || true
  '';
}
