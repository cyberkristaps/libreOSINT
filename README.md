# libreOSINT

A local-first OSINT and link-analysis workbench for security researchers.

<img width="2880" height="1760" alt="image" src="https://github.com/user-attachments/assets/2c172735-e23a-4144-aa2d-b2e7d295bb91" />


**Features:** graph canvas · 14 entity types with automatic de-duplication · built-in lookups (DNS, certificates, RDAP, open ports, HTTP headers, page text, web search, username search) · AI investigator on local Ollama · proxy routing for lookups · undo/redo · one SQLite `.case` file per investigation.

## Build

Requires Node.js 22+, Rust and Python 3.9+ (on Windows, add Python to PATH). Windows also needs the Visual Studio C++ Build Tools and Linux the WebKitGTK libraries: see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri build
```

The app is written to `src-tauri/target/release/bundle/`.

## Responsible use

Use libreOSINT only for investigations you are authorised to carry out.
