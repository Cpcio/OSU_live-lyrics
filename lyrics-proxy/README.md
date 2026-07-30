# tosu Lyrics Proxy Prototype

This is a loopback-only replacement for the subset of `api-enhanced` used by
Live Lyrics. It binds to `127.0.0.1:3002` by default and exposes only:

- `GET` or `POST /audio/match`
- `GET` or `POST /lyric/new`
- `GET` or `POST /lyric`
- `GET` or `POST /search`
- `GET` or `POST /cloudsearch`
- `GET` or `POST /mv/for-song`
- `GET` or `POST /bilibili/background`
- `GET` or `HEAD` /bilibili/media (loopback-only Bilibili video stream with the required Referer header)
- `POST /song-cache`
- `GET /health`

## Development Test

Install dependencies once:

```powershell
npm install
```

Start the proxy:

```powershell
npm start
```

Set the Live Lyrics settings to:

```text
NetEase API Base: http://127.0.0.1:3002
Song Cache Writer: http://127.0.0.1:3002/song-cache
```

The old full `api-enhanced` process is not needed while this proxy is running.

## Bilibili Blacklist

`bilibili-blacklist.txt` sits beside `lyrics-proxy.exe`. It supports
`[blacklist]` and `[whitelist]` sections. Blacklist terms exclude matching
titles, descriptions, and authors. Whitelist terms score matching candidate
titles higher while candidates without a match lose score. The proxy evaluates
the first five search results that pass duration checks, then uses the highest
score. Lines beginning with `#` are comments, and the file is re-read when it
changes, so the proxy does not need to be restarted.

## Packaging

`pkg` embeds Node.js, the proxy code, and its JavaScript dependencies into a
single executable. Build both programs with:

```powershell
npm run build
```

Outputs:

- `dist/lyrics-proxy.exe`: the loopback proxy.
- `dist/Start-Tosu-Lyrics.exe`: starts the proxy, waits for `/health`, finds
  `tosu.exe` relative to the plugin folder, and stops the proxy when tosu exits.

For release, place both EXEs beside the plugin's `index.html` and
`song-cache.json`. The packaged launcher then finds its sibling
`lyrics-proxy.exe` and writes the cache beside itself.

With the standard `tosu/static/plugin-folder` layout no configuration is
needed. At runtime, `TOSU_PATH` can override the automatic relative lookup:

```powershell
$env:TOSU_PATH = 'D:\Apps\tosu\tosu.exe'
.\dist\Start-Tosu-Lyrics.exe
```

`pkg` does not compile JavaScript into native machine code. It bundles a Node
runtime and application files into one EXE, which removes the requirement for a
separate Node installation while retaining normal Node behavior.
