{
  pkgs,
  lib,
  config,
  inputs,
  ...
}:

{
  packages = [
    pkgs.git
    pkgs.nodejs_26
    pkgs.fd
    pkgs.ripgrep
    pkgs.sqlite
    pkgs.jq
  ];

  scripts.setup.exec = ''
    npm install
  '';

  scripts.test.exec = ''
    npm test
  '';

  scripts.check.exec = ''
    npm run typecheck
  '';

  enterShell = ''
    echo "mason dev shell (node $(node --version))"
  '';
}
