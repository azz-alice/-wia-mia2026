Judul : Informasi Lingkungan dan Kesiapsiagaan Bencana Indonesia
Website ini dibuat oleh tim kami yaitu Tim sEm4nGa7 k0Mp4k AnT1 mLeS untuk membahas kondisi lingkungan dan bencana yang terjadi di Indonesia. Kami ingin menyajikan informasi dengan cara yang mudah dipahami melalui peta interaktif dan penjelasan di dalam website.

Tentang Website :
Melalui website ini kami ingin mengajak pengunjung untuk lebih mengenal kondisi lingkungan di Indonesia mulai dari aktivitas gunung berapi, kebakaran hutan dan lahan, hingga kualitas udara.

Informasi disajikan melalui peta dan artikel agar pengunjung bisa melihat persebaran suatu kondisi sekaligus memahami penyebab dan dampaknya bagi masyarakat.

Fitur :
- Peta interaktif Indonesia yang bisa dipilih berdasarkan wilayah provinsi.
- Peta lokasi gunung api beserta status aktivitasnya dari Level I-IV.
- Informasi dan persebaran titik panas karhutla beserta grafik perbandingan provinsi.
- Visualisasi kualitas udara berdasarkan data partikel PM2.5.
- Artikel yang membahas penyebab, dampak, dan langkah menghadapi bencana pada setiap topik.

Tech Stack :
- HTML, CSS, dan JavaScript untuk membuat tampilan halaman dan mengatur interaksi di dalam website.
- Leaflet untuk menampilkan peta interaktif.
- Python untuk membantu mengolah dan merapikan beberapa file data peta.

Tools Pendukung :
- GPT digunakan untuk membantu analisis topik dan mencari beberapa referensi data yang dibutuhkan.
- Antigravity digunakan untuk membantu proses debugging dan evaluasi.

Progress Development :
- Halaman utama atau landing page sudah selesai.
- Halaman peta gunung berapi dan pembahasan materinya sudah selesai.
- Halaman dashboard peta karhutla dan kualitas udara sudah selesai.
- Pengolahan data peta dan penyesuaian tampilan di berbagai ukuran layar sudah selesai.

Informasi Tim :
Tim : Tim sEm4nGa7 k0Mp4k AnT1 mLeS
Asal sekolah : SMK Telkom Sidoarjo
Subtema : Kesehatan dan Lingkungan
Anggota :
- Adhipramana Fadli Arifin
- Daffa Ranu Yoga Pratama
- Arsy Alvaro Putra

Cara Menjalankan di Komputer Lokal :
Website ini memuat data peta melalui pembacaan file JSON sehingga disarankan menggunakan server lokal sederhana.

Pertama clone repository ini dari GitHub lalu masuk ke foldernya:
git clone <url-repository>
cd <nama-folder>

Untuk melihat halaman di VS Code, buka `index.html`, klik kanan lalu pilih **Open with Live Server** (atau tekan **Go Live**). Live Server akan memilih alamatnya sendiri; tidak perlu mengisi domain, IP, atau port. `index.html` memakai rute relatif untuk membuka beranda di `main/`.

Live Server menyajikan halaman frontend. Daftar laporan menggunakan snapshot baca-saja jika Supabase belum dikonfigurasi. Pengiriman laporan dan panel moderator memerlukan Supabase yang dikonfigurasi di `site-config.js`; Live Server bukan backend API. Jangan membuka berkas HTML dengan klik dua kali (`file://`).

## Alamat Halaman

Folder proyek harus diunggah bersama struktur foldernya. Halaman yang tersedia:

- `/` atau `/main/` — beranda.
- `/gunung-berapi/` — peta dan informasi gunung berapi.
- `/karhutla/` — peta karhutla dan kualitas udara.
- `/laporan/` — formulir dan daftar laporan masyarakat.
- `/admin-panel/` — login moderator dan moderasi laporan.

Nama folder dan berkas menggunakan huruf kecil serta tanda hubung. Jangan mengganti nama folder tanpa memperbarui tautan relatif di halaman. Hosting harus menyajikan `index.html` dalam folder; jika URL hosting memakai subfolder, unggah seluruh isi repositori sebagai satu kesatuan.

## Deploy Online (Hosting Statis + Supabase)

Untuk situs online, gunakan alamat bawaan hosting (domain kustom opsional), dan siapkan Supabase untuk laporan serta moderasi:

1. Buat proyek Supabase dan salin **Project URL** serta **anon/public key**. Isi kedua nilai itu di `site-config.js`:

   ```js
   window.ENV_SUPABASE_URL = "https://PROJECT_REF.supabase.co";
   window.ENV_SUPABASE_ANON_KEY = "ANON_PUBLIC_KEY";
   ```

   URL dan anon key memang dipakai browser. Jangan pernah menaruh `service_role` key, kata sandi, atau NASA/OpenAQ key di berkas ini.

2. Dari folder repositori, tautkan Supabase CLI ke proyek yang benar lalu jalankan migrasi SQL:

   ```text
   supabase login
   supabase link --project-ref PROJECT_REF
   supabase db push
   ```

   Migrasi menyiapkan tabel, kebijakan akses, dan fungsi laporan. Terapkan migrasi `20261110000000`, `20261110010000`, `20261111000000`, dan `20261112000000` secara berurutan; migrasi terakhir menghapus alur serta kolom tanggal dampak Karhutla.

3. Deploy Edge Functions yang dipakai aplikasi:

   ```text
   supabase functions deploy community-reports
   supabase functions deploy environment-summary
   supabase functions deploy sync-nasa-firms
   supabase functions deploy sync-openaq-pm25
   ```

   `community-reports` harus mengizinkan request publik sesuai `supabase/config.toml`; hak moderasi tetap diperiksa lewat akun Supabase Auth dan `moderator_profiles`.

4. Buat akun moderator di Supabase Auth, lalu tambahkan profil moderator aktif yang menunjuk ke UUID akun tersebut. Jangan membuat akun moderator dengan membagikan service key atau menyimpan kata sandi di frontend.

5. Untuk pembaruan data langsung, masukkan `NASA_FIRMS_MAP_KEY` dan `OPENAQ_API_KEY` sebagai **Edge Function secrets** di Supabase, lalu jadwalkan pemanggilan `sync-nasa-firms` dan `sync-openaq-pm25` (interval yang digunakan aplikasi adalah 60 menit). Kedua key ini tidak diperlukan agar halaman statis dan data peta bawaan dapat ditampilkan, tetapi diperlukan untuk pembaruan data terbaru dari sumbernya.

6. Deploy seluruh isi folder proyek ke hosting statis dengan HTTPS. Uji URL kelima halaman di atas. Pastikan `site-config.js` ikut terunggah dan hanya berisi Project URL serta anon/public key.

### Konfigurasi yang Tidak Boleh Dipublikasikan

- `SUPABASE_SERVICE_ROLE_KEY`: simpan sebagai secret server/Edge Function saja; tidak boleh berada di `site-config.js`, HTML, atau JavaScript browser.
- `NASA_FIRMS_MAP_KEY` dan `OPENAQ_API_KEY`: simpan sebagai Edge Function secrets (atau di `.env` untuk `sync_realtime.py` lokal).
- Jangan unggah `.env`. Berkas itu diabaikan Git.

Jika Supabase belum dikonfigurasi, halaman peta masih dapat menampilkan data JSON bawaan dan snapshot laporan masyarakat lokal. Setelah konfigurasi diisi, indikator laporan masyarakat pada peta dan data lingkungan terbaru dimuat dari Supabase; kirim laporan, login/moderasi online, dan pembaruan data dari Supabase memerlukan migrasi serta Edge Functions yang sudah aktif. Fitur laporan memakai database Supabase persisten; backend SQLite hanya lokal. Formulir Karhutla tidak menggunakan unggah foto atau tanggal mulai dampak.

Penutup :
Kami berharap website ini bisa membantu pengunjung memahami informasi mengenai lingkungan dan bencana di Indonesia dengan lebih mudah. Semoga informasi yang disajikan juga bisa menambah pengetahuan dan kepedulian kita terhadap lingkungan sekitar.

Indonesia adalah negara kepulauan dengan lebih dari 15.000 pulau yang memiliki kondisi alam beragam serta ratusan jenis mamalia, reptil, amfibi, ribuan jenis burung, dan kekayaan ikan laut. Dengan keragaman hayati tersebut sudah sepatutnya kita menjaga alam yang Tuhan berikan dan yang telah dijaga oleh leluhur kita sejak dulu. Semoga bencana yang terjadi segera selesai dan saudara kita yang sedang mengalami musibah segera mendapatkan pertolongan serta selalu diberikan keselamatan oleh Tuhan.
