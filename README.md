# StudioStream Mixer (Fender Studio One Edition)

Aplikasi desktop audio mixer standalone (mirip GP Mix Lite) untuk **macOS** dan **Windows**, dirancang khusus untuk kebutuhan **Live Streaming, OBS Studio, dan TikTok Live Studio (TTLS)**, dengan antarmuka yang mengadaptasi **Fender Studio One Console** serta **2-Way Wi-Fi Mobile Remote** bawaan.

## Fitur Utama

1. **Audio Engine Native C++17 (Zero External Dependencies)**
   - **macOS**: CoreAudio / AudioToolbox (`MacAudioBackend.cpp`).
   - **Windows**: WASAPI Capture + Dual Render (`WinAudioBackend.cpp`).
   - **Dual Independent Output Bus**:
     - **Stream Out (OBS / TTLS)**: kirim ke Virtual Audio Cable (misal BlackHole 2ch di macOS atau VB-Cable di Windows) untuk ditangkap oleh OBS Studio dan TikTok Live Studio.
     - **Monitor Out (Headphone)**: kirim ke headphone/headset Anda agar dapat memantau suara (Solo/PFL, cue, playback) tanpa bocor atau feedback ke stream.

2. **Fender Studio One Console & Fat Channel DSP**
   - 6 Channel Strip siap streaming: `Mic / Vocal`, `Music / BGM`, `Game / TTLS`, `Guest / Call`, `Soundboard`, dan `Reverb FX`.
   - **Fat Channel Inspector**: High-Pass Filter (HPF), Noise Gate (threshold & range), 3-Band EQ (Low Shelf, Mid Peak, High Shelf), Compressor (Threshold, Ratio + Gain Reduction Meter), Stereo Reverb Send, dan Pan.
   - **Auto-Ducking Sidechain**: otomatis mengecilkan BGM/Game ketika mikrofon mendeteksi suara Anda berbicara.
   - **Real-time 25 Hz Metering**: Peak meter stereo L/R dan Gain Reduction (GR) meter disinkronkan real-time ke Desktop dan HP Remote.

3. **Soundboard / Stinger Pads & Scene Recall**
   - 8 pad stinger bawaan (siap pakai) dan dukungan upload file WAV PCM 16-bit langsung dari UI.
   - 4 Preset Scene: `Live Talk`, `Karaoke / Cover`, `Gaming / TTLS`, dan `BRB / Intermission`.

4. **2-Way Wi-Fi Mobile Remote (Tanpa Install App)**
   - Buka QR Code / IP LAN yang tampil di tombol **HP Remote** untuk mengontrol mixer dari HP Android/iPhone dalam jaringan Wi-Fi yang sama secara 2 arah.

---

## Cara Build Otomatis & Download Paket Siap Pakai via GitHub

Folder ini sudah dilengkapi workflow GitHub Actions di `.github/workflows/build-release.yml` yang otomatis membangun paket **Portable Siap Pakai** (sudah berisi binary audio engine `.exe`/macOS **dan** runtime Node.js portable, jadi **tidak perlu install compiler maupun Node.js** di PC tujuan):

1. Inisialisasi Git & push folder ini ke repository GitHub Anda (`main` atau `master`):
   ```bash
   git init
   git add .
   git commit -m "Initial StudioStream Mixer"
   git branch -M main
   git remote add origin https://github.com/<USERNAME>/<REPO>.git
   git push -u origin main
   ```
2. Buka tab **Actions** di GitHub -> klik workflow **Build & Release StudioStream Mixer** -> setelah hijau, download langsung:
   - `StudioStream-Mixer-Windows-x64.zip` (berisi `build\studio-stream-engine.exe` + `runtime\node.exe`)
   - `StudioStream-Mixer-macOS.zip` (berisi Universal `studio-stream-engine` & `StudioStreamDesktop` + `runtime/node` arm64)
3. Untuk menerbitkan ke halaman **GitHub Releases**, buat & push tag versi (misal `v1.0.0`):
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

---

## Cara Menjalankan

### Dari Paket GitHub Release (Tanpa Install Compiler / Node.js)
- **Windows**: ekstrak `StudioStream-Mixer-Windows-x64.zip`, lalu klik ganda **`Start StudioStream (Windows).bat`**.
- **macOS**: ekstrak `StudioStream-Mixer-macOS.zip`. Pada klik pertama, klik kanan **`Start StudioStream (macOS).command`** -> **Open** (untuk melewati Gatekeeper aplikasi non-notarized), lalu aplikasi terbuka otomatis. *(Untuk Mac Intel, install Node.js LTS jika runtime arm64 tidak cocok.)*

### Dari Source Code (Developer)
- **macOS**: pastikan Node.js & Xcode Command Line Tools terpasang, lalu jalankan `npm run desktop` atau klik ganda **`Start StudioStream (macOS).command`**.
- **Windows**: pastikan Node.js + `g++` (MSYS2/MinGW-w64) atau MSVC `cl` terpasang, lalu klik ganda **`Start StudioStream (Windows).bat`**.

---

## Panduan Routing ke OBS Studio & TikTok Live Studio

1. Install virtual audio driver:
   - **macOS**: [BlackHole 2ch](https://existential.audio/blackhole/)
   - **Windows**: [VB-Cable Virtual Audio Device](https://vb-audio.com/Cable/)
2. Di **StudioStream Mixer**, klik tombol **Audio Setup**:
   - **Mic Input**: pilih mikrofon/audio interface Anda.
   - **Stream Out (OBS/TTLS)**: pilih **BlackHole 2ch** (macOS) atau **CABLE Input** (Windows).
   - **Monitor Out (Headphone)**: pilih headphone/speaker monitor Anda.
3. Di **OBS Studio** atau **TikTok Live Studio**:
   - Tambahkan **Audio Input Capture** / pilih sumber mikrofon = **BlackHole 2ch** (macOS) atau **CABLE Output** (Windows).
4. Klik tombol **Test Tone** di Inspector bila ingin memastikan meter dan routing audio berjalan sebelum Live dimulai.
