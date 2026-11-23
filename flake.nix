{
  description = "mason — a pi-durable harness with a home behind it";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      # Linux x64 is what the dev shell is checked on. The native part mason needs, the pi-env daemon, comes inside its
      # npm package.
      systems = [ "x86_64-linux" ];
      forAll = nixpkgs.lib.genAttrs systems;
    in
    {
      # No `packages`: this build is a library, not a command. The SDK is consumed from a checkout with
      # `--experimental-strip-types`, and there is nothing to install into `$out` until there is a `dist/` and a `prepack`.
      devShells = forAll (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_26
              pkgs.git
              pkgs.fd
              pkgs.ripgrep
              pkgs.sqlite
              pkgs.jq
            ];
            shellHook = ''
              echo "mason dev shell (node $(node --version))"
            '';
          };
        }
      );

      formatter = forAll (system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style);
    };
}
