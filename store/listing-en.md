# Chrome Web Store Listing Copy (English)

> Optional localization. If you add English as a listing language, paste the fields below.

---

## Name (≤ 75 chars)

```
Video Sniffer Downloader - Save Web Video & HLS (m3u8)
```

## Summary (≤ 132 chars)

```
Detect video streams playing in your browser and save them locally: HLS (m3u8), MP4, WebM and DASH, with quality picker and local merging.
```

Char count: 139 → **trim to**:

```
Detect videos playing in your browser and save them locally: HLS (m3u8), MP4, DASH, with quality picker and automatic audio+video track merging.
```

Char count: 135 → **trim to**:

```
Detect videos playing in your browser and save them: HLS (m3u8), MP4, DASH, with quality picker and automatic audio+video merging.
```

Char count: 130 ✅

---

## Detailed description

```
[What it does]
Video Sniffer Downloader watches the video resources your current page is loading and turns them into a clean list. You pick one, click Download, and it handles the rest.

[The problem it solves]
Most web video is not a single saveable file. It is split into hundreds of segments (m3u8 / m4s / ts), or handed to the player as a blob: URL, so "Save video as" simply does not work.
Worse, sites like Bilibili and Douyin deliver **picture and sound as two separate streams**. Downloading them manually leaves you with one file that has video but no audio, and another that has audio but no video.
This extension makes it work: play the video, the real stream URL shows up in the list, choose your quality, click download — and the two tracks come out as one playable file.

[Features]
• Three complementary discovery channels: (1) live network request monitoring; (2) when you open the popup or press rescan, the browser's resource timeline is replayed to recover media requests that happened *before* the extension started observing; (3) scanning of <video> elements.
• Content-signature detection: some sites serve m3u8 as text/plain and use extension-less URLs, which extension matching and response headers alone will always miss. The extension reads the first few KB of the response and classifies it by content (#EXTM3U / MPD / ftyp / TS sync bytes); anything confirmed as non-media is removed so the list stays clean.
• Broad format coverage: HLS (.m3u8, including master playlists with separate audio groups), DASH (.mpd manifests are parsed), MP4, WebM, FLV, MKV, fMP4 (.m4s) and TS segments, clearly labelled.
• Automatic audio/video track merging (Bilibili, Douyin, YouTube and other split-stream sites): every track is inspected to tell whether it is a video track or an audio track, and the matching pair is interleaved into **one** file with both picture and sound — no ffmpeg and no external tools. Several real-world shapes are covered: .m4s chunks, extension-less video/mp4 + audio/mp4 pairs, YouTube-style URLs where the role is declared by `&mime=` on an identical path (including `&range=` requests, which are collapsed back into a single track), HLS `#EXT-X-MEDIA` audio groups, audio/video Representations inside a DASH manifest, and WebM (VP9/Opus) tracks — merged output stays `.webm` and is never mislabelled as `.mp4`. A "video only" option is available for the bare video track; if merging ever fails, video and audio are saved separately so nothing is lost.
• DASH manifests read directly: the quality picker lists the video renditions found in the manifest (resolution / codec / bitrate / segment count) without waiting for the player to request every segment; if the manifest also carries an audio Representation, it is fetched and merged automatically.
• Quality picker: parses master playlists (HLS) and MPD manifests (DASH) and lists every rendition, sorted by resolution/bitrate (up to 4K tiers).
• Local merge & remux: segments are fetched in parallel and merged on your machine. Bundled mux.js remuxes TS to standard MP4 inside the browser — no ffmpeg required. If remuxing fails, it falls back to a playable TS file.
• Encrypted HLS: handles #EXT-X-KEY AES-128 streams, decrypting locally.
• Referer retry: some sites validate the request origin. If a normal download is rejected, the extension retries the same file through a channel that supplies the correct origin.
• Live progress: segment count, downloaded size and real-time speed. Tasks can be cancelled and keep running after you close the popup.
• Copy stream URL: copy the real URL of any detected resource to the clipboard and continue with yt-dlp, ffmpeg or any other tool.
• Live stream awareness: detects playlists without #EXT-X-ENDLIST and warns that only buffered segments can be saved.

[Privacy and safety]
• No server, no account. There is no backend. Parsing, decryption and merging all happen on your computer. No browsing history, no download history and no video content is uploaded.
• No analytics, no ads, no tracking SDKs.
• Clear technical boundary: this extension does NOT bypass DRM (Widevine / PlayReady / FairPlay). DRM-protected content simply fails — that is by design.
• Built-in usage policy and privacy policy, linked from the popup footer.

[Permissions]
• webRequest — read-only observation of page requests to identify video URLs. Nothing is modified, blocked or spoofed.
• downloads — saves the resource you click to your local Downloads folder.
• declarativeNetRequest / storage / tabs / offscreen — used to supply the origin header, store your settings, attribute results to the right tab, and merge/decrypt segments locally.

[How to use]
1. Open a page with video and start playback.
2. Click the extension icon and wait for resources to appear (or press ⟳ to rescan).
3. For HLS, click "choose quality". When a row is labelled "M4S · video" or "Video track", click "Download (with sound)" to get a single MP4 containing both picture and audio. For other files, click Download.
4. Progress appears in the "Download tasks" section; files land in your browser's download folder.

[What it is NOT for]
• It does not and will not break DRM-protected content.
• Some sites use short-lived signed URLs, tokens or strict Referer checks. Downloads may fail; that is the site's legitimate technical measure and the extension will not try to circumvent it.
• Live streams only save segments buffered at the moment you start. It is not a screen recorder.
• Browser internal pages (chrome://, the Web Store itself) cannot be sniffed — a browser limitation.

[Please use responsibly]
Download only content you own, content you are licensed to save, or content the site explicitly allows you to download. You are responsible for complying with local law and the terms of service of the sites you visit.
```

---

## Category / language

- Category: **Productivity**
- Primary language: **English** (secondary listing)
