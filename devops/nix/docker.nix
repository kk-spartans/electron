{
  lib,
  dockerTools,
  app,
  cacert,
}:

let
  pkg = builtins.fromJSON (builtins.readFile ../../package.json);
  image = dockerTools.buildLayeredImage {
    name = "ghcr.io/kk-spartans/electron/electron-app";
    tag = "latest";
    contents = [
      app
      cacert
      dockerTools.fakeNss
    ];
    config = {
      Cmd = [ "/bin/electron-server" ];
      Env = [
        "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
        "PATH=/bin"
        "SERVE_DIR=${app}/out"
        "REACTION_CACHE_DIR=/tmp/electron-ai-reactions"
      ];
      ExposedPorts = {
        "8080/tcp" = { };
      };
      Labels = {
        "org.opencontainers.image.source" = "https://github.com/kk-spartans/electron";
        "org.opencontainers.image.title" = pkg.name;
        "org.opencontainers.image.version" = pkg.version;
      };
    };
    meta = {
      description = "Docker image for ${pkg.name}";
      license = lib.licenses.unlicense;
    };
  };
in
image
// {
  isExe = false;
  passthru = (image.passthru or { }) // {
    isExe = false;
  };

  meta = {
    description = "Docker image for ${pkg.name}";
    license = lib.licenses.unlicense;
  };
}
