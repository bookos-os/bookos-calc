# Bookos Calc

Calculadora ligera para BookOS construida con Tauri 2. Estilo visual emparentado con `bookos-settings` y `bookos-clock`: tarjetas redondeadas, tipografía Onest, paleta clara/oscura automática siguiendo el tema del sistema (KDE / GNOME).

## Características

- Operaciones básicas: `+ − × ÷ % ±`
- Display grande con expresión secundaria estilo One UI
- Botones grandes redondeados, operadores en naranja, `=` en azul de acento
- Historial persistente (hasta 50 entradas) guardado en `~/.config/bookos-calc/state.json`
- Tema auto / claro / oscuro (cíclico desde la barra de título)
- Controles de ventana personalizados (minimizar, maximizar, cerrar)
- Atajos de teclado: dígitos, `+ - * /`, `Enter` / `=`, `.` / `,`, `%`, `Backspace`, `Esc`

## Desarrollo

```sh
cd src-tauri
cargo run
```

## Compilar release

```sh
cd src-tauri
cargo build --release
```

Binario: `src-tauri/target/release/bookos-calc`.

## Empaquetar (.deb / .rpm)

```sh
cd src-tauri
cargo tauri build
```

(necesita `cargo-tauri` instalado).
