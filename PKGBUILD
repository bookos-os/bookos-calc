pkgname=bookos-calc
pkgver=0.6.1
pkgrel=1
pkgdesc="Calculadora científica para BookOS"
arch=('x86_64')
url="https://github.com/Evelynx08/bookos-calc"
license=('MIT')
depends=('webkit2gtk-4.1' 'gtk3' 'libayatana-appindicator' 'librsvg' 'libsoup3')
makedepends=('rust' 'cargo' 'pkgconf' 'base-devel')
source=()
options=('!strip' '!debug')

build() {
  cd "$startdir/src-tauri"
  cargo build --release --locked
}

package() {
  install -Dm755 "$startdir/src-tauri/target/release/bookos-calc" \
    "$pkgdir/usr/bin/bookos-calc"

  install -Dm644 /dev/stdin "$pkgdir/usr/share/applications/bookos-calc.desktop" <<EOF
[Desktop Entry]
Name=Bookos Calc
Comment=Calculadora cientifica BookOS
Exec=bookos-calc
Icon=bookos-calc
Type=Application
Categories=Utility;Calculator;
StartupNotify=true
StartupWMClass=bookos-calc
EOF

  [ -f "$startdir/src-tauri/icons/icon.png" ] && install -Dm644 "$startdir/src-tauri/icons/icon.png" \
    "$pkgdir/usr/share/icons/hicolor/512x512/apps/bookos-calc.png"
  [ -f "$startdir/src-tauri/icons/icon.svg" ] && install -Dm644 "$startdir/src-tauri/icons/icon.svg" \
    "$pkgdir/usr/share/icons/hicolor/scalable/apps/bookos-calc.svg"
}
