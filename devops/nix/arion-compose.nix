{
  config,
  lib,
  pkgs,
  ...
}:
let
  flake = builtins.getFlake (toString ../../.);
  dockerImage = flake.packages.${pkgs.stdenv.hostPlatform.system}.docker;
in
{
  config.project.name = "electron";

  config.services.searxng.service = {
    image = "searxng/searxng:latest";
    volumes = [ "./settings.yml:/etc/searxng/settings.yml:ro" ];
    restart = "unless-stopped";
    cap_drop = [ "ALL" ];
    cap_add = [ "CHOWN" "SETGID" "SETUID" ];
  };

  config.services.electron = {
    build.image = lib.mkForce dockerImage;

    service = {
      env_file = [ "./.env" ];
      depends_on = [ "searxng" ];
      environment = {
        OPENAI_BASE_URL = "\${OPENAI_BASE_URL:-https://api.openai.com/v1}";
        OPENAI_MODEL = "\${OPENAI_MODEL:-gpt-4o-mini}";
        SEARXNG_BASE_URL = "http://searxng:8080";
        PORT = "\${ELECTRON_PORT:-8080}";
      };
      ports = [ "\${ELECTRON_PORT:-8080}:8080" ];
      volumes = [ "./cache:/tmp/electron-ai-reactions" ];
      restart = "unless-stopped";
    };
  };
}
