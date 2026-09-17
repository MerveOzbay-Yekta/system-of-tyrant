# Araç Takip Simülatörü

Saniyede ~450 telemetri isteğini karşılayan, veriyi Redis'e yazan ve WebSocket
üzerinden tarayıcıdaki canlı ekrana basan bir araç takip gateway'i.

```
simulate.js  ──POST /api/telemetry──>  server.js  ──pipeline──>  Redis
 (~450 istek/sn)                           │
                                           └──WebSocket (5 paket/sn)──> tarayıcı
```

---

## 1. Hızlı başlangıç

```bash
cd demotest
npm install

npm start      # 1. terminal — sunucu
npm run sim    # 2. terminal — yük simülasyonu
```

Tarayıcıda **http://localhost:3000** adresini açın. `npm run sim` komutunu
verdiğiniz anda veriler ekrandaki tabloya düşmeye başlar.

> **Redis kurulu değil mi?** Sorun değil — canlı ekran Redis olmadan da
> çalışır. Arayüzdeki "Redis" kutusu kırmızı görünür, veriler yalnızca
> kalıcı olarak saklanmaz. Demoyu görmek için Redis şart değildir.

---

## 2. Gereksinimler

| Bileşen | Sürüm | Zorunlu mu? |
|---|---|---|
| Node.js | 18 veya üzeri | Evet |
| Redis | 6 veya üzeri | Hayır — yoksa ekran yine çalışır |

### Redis kurulumu (Windows)

Redis resmî olarak Windows'u desteklemez. Üç seçenek:

1. **Memurai** — Windows için Redis uyumlu sunucu: <https://www.memurai.com/get-memurai>
2. **WSL2** — `wsl --install`, ardından `sudo apt install redis-server && sudo service redis-server start`
3. **Docker** — `docker run -d -p 6379:6379 redis:7`

Kurulumdan sonra doğrulayın:

```bash
npm run fix-redis
```

Bu komut Redis'e bağlanır, yazma iznini gerçekten test eder ve sorun varsa
ne olduğunu açıkça söyler.

---

## 3. Bilinen sorun: "MISCONF" / ekran boş kalıyor

Bu projede günün büyük kısmını alan sorun buydu, bu yüzden burada duruyor.

**Belirti:** Sunucu ve tarayıcı sorunsuz görünür, `npm run sim` "Errors: 0"
yazar, ama ekrana tek satır düşmez.

**Sebep:** Redis'in `dir` ayarı yazma izni olmayan bir klasörü (çoğunlukla
sürücü kökü `C:\`) gösterir. RDB snapshot alınamaz, Redis de
`stop-writes-on-bgsave-error` kuralı gereği **tüm yazma komutlarını reddeder**:

```
MISCONF Redis is configured to save RDB snapshots, but it is currently
not able to persist on disk...
```

**Çözüm:**

```bash
npm run fix-redis
```

**Neden "Errors: 0" yazıyordu?** autocannon'un `errors` sayacı yalnızca
ağ/timeout hatalarını sayar; HTTP 500 yanıtları `non2xx`'e yazılır. Bu yüzden
simülatör çıktısına `2xx` / `non-2xx` satırları eklendi. Artık sunucu hata
dönüyorsa terminalde görürsünüz.

---

## 4. Komutlar

| Komut | Açıklama |
|---|---|
| `npm start` | Gateway'i 3000 portunda başlatır |
| `npm run sim` | ~450 istek/sn, 30 saniyelik yük simülasyonu |
| `npm run fix-redis` | Redis'i teşhis eder, MISCONF sorununu giderir |

### Ortam değişkenleri

Hiçbiri zorunlu değildir; hepsinin makul varsayılanı vardır.

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket portu |
| `REDIS_HOST` | `127.0.0.1` | Redis adresi |
| `REDIS_PORT` | `6379` | Redis portu |
| `REDIS_URL` | — | Tam bağlantı adresi (`redis://...`), diğerlerini geçersiz kılar |
| `TARGET_URL` | `http://localhost:$PORT` | `npm run sim` komutunun yük basacağı adres |

```bash
# 3000 portu meşgulse (sim de aynı değişkeni okur):
PORT=3001 npm start
PORT=3001 npm run sim

# Redis başka makinede:
REDIS_URL=redis://192.168.1.50:6379 npm start
```

Windows PowerShell'de:

```powershell
$env:PORT=3001; npm start
```

### `npm install` sırasındaki güvenlik uyarısı

`npm install` sonunda 3 adet "moderate" uyarı görebilirsiniz. Bunların kaynağı
`autocannon` paketinin alt bağımlılığı olan `uuid`'dir. `autocannon` yalnızca
bir **devDependency**'dir ve sadece yük simülasyonunda kullanılır — sunucunun
çalışma yolunda yer almaz. `npm audit fix --force` komutu autocannon'u 2.0.1'e
düşürerek `simulate.js`'i bozar; **çalıştırmayın**.

---

## 5. HTTP uçları

| Uç | Ne yapar |
|---|---|
| `POST /api/telemetry` | Telemetri kabul eder. Gövde: `{ vehicleId, lat, lon, speed }` |
| `GET /api/vehicles` | Redis'teki güncel filo durumunu döner |
| `GET /api/health` | Redis durumu, araç sayısı, bağlı istemci, istek hızı |
| `GET /` | Canlı takip ekranı |

Sistemin durumunu tek komutla görmek için:

```bash
curl http://localhost:3000/api/health
```

---

## 6. Mimari notlar

Sistemin 450 istek/sn altında ayakta kalmasını sağlayan üç karar:

**1. HTTP isteği Redis'i beklemez.**
`POST /api/telemetry` yalnızca belleğe yazıp anında 200 döner. Redis'e yazma
ve WebSocket yayını ayrı zamanlayıcılarda toplu yapılır. Bu sayede Redis
yavaşlasa veya tamamen çökse bile canlı ekran akmaya devam eder.

**2. Redis'e toplu yazma.**
İstek başına `hset` yerine 100 ms'de bir pipeline. 450 ayrı gidiş-dönüş yerine
saniyede 10 paket. Aynı araç o aralıkta 5 kez güncellendiyse Redis'e 1 kez yazılır.

**3. Tarayıcıya toplu yayın.**
İstek başına WebSocket paketi yerine 200 ms'de bir toplu paket — saniyede 5.
İçinde yalnızca o aralıkta değişen araçlar bulunur ve her araç pakette en fazla
bir kez geçer. Tarayıcı tarafında her araç için bir tablo satırı **bir kez**
oluşturulur, sonraki güncellemelerde yalnızca hücre metni değişir; DOM büyümez.

---

## 7. Ölçülen sonuçlar

30 saniyelik `npm run sim` koşusu (Windows 11, yerel Redis):

```
req/sec       : 451.5
2xx           : 13545
non-2xx       : 0
errors        : 0
ortalama gecikme : 12.02 ms

WebSocket     : 161 paket / 34 sn  (~4.7 paket/sn)
              : 10.965 araç satırı  (13.545 istekten sıkıştırıldı)
Redis         : 500 araç kaydı, 0 yazma hatası
```

Bağlantı sayısının ölçüme etkisi — `overallRate` bağlantılara bölündüğü için
fazla bağlantı, autocannon'un kendi sıra bekleme süresini gecikmeye ekler:

| `connections` | Raporlanan gecikme |
|---|---|
| 10 | 5.27 ms |
| 50 | 23.71 ms |

Sunucunun gerçek gecikmesi ilkidir; `simulate.js` bu yüzden 10 bağlantı kullanır.

---

## 8. Dosya düzeni

```
demotest/
├── server.js          Gateway: HTTP + WebSocket + Redis katmanı
├── simulate.js        Yük simülatörü (autocannon)
├── fix-redis.js       Redis teşhis ve onarım betiği
├── public/
│   └── index.html     Canlı takip ekranı
└── README.md
```

Her üç JavaScript dosyası da hangi kararın neden alındığını anlatan ayrıntılı
yorum satırları içerir.
