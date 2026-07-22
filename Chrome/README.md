# E-Hentai Downloader - Opera Extension

Browser extension for Opera that automatically downloads images from e-hentai.org galleries as ZIP/CBZ files.

Based on [ccloli/E-Hentai-Downloader](https://github.com/ccloli/E-Hentai-Downloader) (GPL-3.0), rewritten as a Manifest V3 extension.

## Features

- Download entire galleries as ZIP or CBZ files
- Multi-threaded image downloading (configurable 1-10 threads)
- Configurable retry on failed downloads
- Page range selection (e.g. `1-5, 10-15`)
- Image numbering option
- Gallery metadata included in archive
- Pause/Resume/Stop controls
- Dark UI that matches e-hentai theme
- Settings persisted via chrome.storage

## Install (Developer Mode)

1. Open Opera and go to `opera://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `ehentai-downloader-extension` folder
5. Pin the extension icon to your toolbar

## Usage

1. Navigate to any gallery page on e-hentai.org or exhentai.org (URL pattern: `/g/...`)
2. The downloader panel will appear at the top of the gallery page
3. Click **Download Gallery** to start
4. Optional: configure page range, threads, and settings before starting
5. Wait for completion - the ZIP/CBZ will be saved to your downloads folder

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Max threads | 3 | Number of parallel image downloads (1-10) |
| Retry count | 3 | Retries per failed image (0-10) |
| Delay | 500ms | Delay between downloads per thread |
| Number images | off | Prefix filenames with sequence number |
| Save as CBZ | off | Save as .cbz (comic book archive) |
| Gallery info | on | Include info.txt with metadata |
| Safe filenames | on | Replace dangerous characters in filenames |

## Notes

- Images are fetched from the same session cookies, so you need to be logged in for exhentai.org galleries
- For very large galleries (>500 images), consider using [gallery-dl](https://github.com/mikf/gallery-dl) for stability
- The extension respects E-Hentai's rate limits; increase delay if you encounter throttling
- ZIP files are created in memory using JSZip - large galleries may use significant RAM

## File Structure

```
ehentai-downloader-extension/
  manifest.json          # MV3 manifest
  background.js          # Service worker (ZIP download handler)
  content.js             # Content script (UI + gallery parser)
  content.css            # Injected panel styles
  popup.html/js          # Extension popup settings
  lib/jszip.min.js       # ZIP compression library
  icons/                 # Extension icons
```

## License

GPL-3.0 (same as original project)
