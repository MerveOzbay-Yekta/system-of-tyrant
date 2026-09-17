/* ============================================================================
 * ARAÇ TAKİP GATEWAY — ~450 istek/sn telemetri → Redis + WebSocket → tarayıcı
 * ============================================================================
 *
 * BULUNAN ASIL HATA (bu dosyanın yeniden yazılma sebebi):
 * ---------------------------------------------------------------------------
 * Redis'in "dir" ayarı sürücü kökünü (C:\) gösteriyordu. Windows 11'de orası
 * yönetici izni olmadan yazılamaz, bu yüzden RDB snapshot alınamıyordu:
 *     rdb_last_bgsave_status:err
 * Redis bu durumda kendini koruma moduna geçip TÜM yazma komutlarını reddeder:
 *     MISCONF Redis is configured to save RDB snapshots, but it is currently
 *     not able to persist on disk... (stop-writes-on-bgsave-error)
 *
 * Eski kodda zincir şöyle kırılıyordu:
 *     await redis.hset(...)      ->  MISCONF hatası fırlatır
 *     catch (error) { ... }      ->  akış buraya atlar
 *     res.status(500)            ->  istek hata ile biter
 *     wss.clients.forEach(send)  ->  BU SATIRA HİÇ GELİNMEZ
 * Yani WebSocket köprüsü sağlamdı; yayın satırına hiç ulaşılmadığı için ekran
 * boş kalıyordu. Ölçüm: 3 POST denendi, 3'ü de 500 döndü, 0 WS verisi geldi.
 *
 * ÇÖZÜM İKİ AYAKLI:
 *   1) Redis tarafı (bu dosyanın dışında, runtime ayarı):
 *        CONFIG SET stop-writes-on-bgsave-error no
 *        CONFIG SET save ""
 *      Kalıcı olması için redis.conf'a da yazılmalı; aksi halde redis-server
 *      yeniden başlayınca aynı hata geri gelir.
 *   2) Kod tarafı (aşağısı): ekran artık Redis'e bağımlı değil. Redis hata
 *      verse bile canlı akış durmaz — tek bir bağımlılık tüm sistemi sessizce
 *      kilitleyemesin diye.
 * ========================================================================= */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const Redis = require('ioredis');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// [DEĞİŞİKLİK 1] Redis bağlantısı savunmacı ayarlarla kuruldu.
// ÖNCE : new Redis()  -> varsayılanda enableOfflineQueue=true idi. Redis
//        koparsa komutlar bellekte sonsuza kadar kuyruklanır, "await" asla
//        dönmez ve HTTP istekleri birer birer asılı kalırdı.
// SONRA: kuyruk kapalı + deneme sayısı sınırlı -> Redis yoksa komut HEMEN
//        hata verir, biz de bu hatayı yutup akışa devam ederiz.
// Bağlantı bilgisi ortam değişkeninden okunur; hiçbiri verilmezse
// localhost:6379 varsayılır. Böylece farklı bir makinede/portta Redis
// çalıştıran biri kodu düzenlemeden projeyi ayağa kaldırabilir.
const redisAyarlari = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false // Redis düşerse istekler kuyrukta birikip API'yi kilitlemesin
};
// REDIS_URL verilmişse onu kullan; ayarlar ikinci argümanla yine geçerli olur.
const redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, redisAyarlari)
    : new Redis(redisAyarlari);

// [DEĞİŞİKLİK 2] 'error' dinleyicisi eklendi.
// Node'da EventEmitter'ın yakalanmamış 'error' olayı süreci komple çökertir.
// Eski kodda dinleyici yoktu; Redis'in kopması sunucuyu düşürebilirdi.
// Log saniyede bir kez basılır, aksi halde saniyede 450 hata satırı akar.
let sonRedisHatasi = 0;
redis.on('error', (err) => {
    if (Date.now() - sonRedisHatasi > 1000) {
        sonRedisHatasi = Date.now();
        console.error('⚠️  Redis hatası:', err.message);
        if (err.code === 'ECONNREFUSED') {
            console.error('   Redis çalışmıyor gibi görünüyor. Canlı ekran yine de çalışır,');
            console.error('   yalnızca kalıcı depolama devre dışı kalır. Kurulum için README.md.');
        }
    }
});

// [DEĞİŞİKLİK 13] AÇILIŞ SAĞLIK KONTROLÜ.
// Bu projeyi ilk kurduğumuzda günün büyük kısmı "ekran neden boş?" sorusuna
// gitti; sebep Redis'in sessizce yazmayı reddetmesiydi (MISCONF). Aynı duvara
// çarpan bir sonraki kişi sebebi tahmin etmek zorunda kalmasın diye, sunucu
// açılırken gerçek bir yazma denemesi yapıp sonucu açıkça söylüyor.
let saglikKontroluYapildi = false;
redis.on('ready', async () => {
    if (saglikKontroluYapildi) return; // yeniden bağlanmalarda tekrarlamasın
    saglikKontroluYapildi = true;
    try {
        await redis.set('gateway:healthcheck', Date.now(), 'EX', 60);
        console.log('✅ Redis bağlantısı ve yazma testi başarılı.');
    } catch (err) {
        if (/MISCONF/.test(err.message)) {
            console.error('');
            console.error('❌ REDIS YAZMAYI REDDEDİYOR (MISCONF)');
            console.error('   Redis, RDB snapshot dosyasını diske yazamadığı için kendini');
            console.error('   koruma moduna almış ve TÜM yazma komutlarını kapatmış durumda.');
            console.error('   En sık sebep: "dir" ayarının yazma izni olmayan bir klasörü');
            console.error('   (örneğin sürücü kökü C:\\) göstermesi.');
            console.error('');
            console.error('   ÇÖZÜM:  npm run fix-redis');
            console.error('');
            console.error('   Not: Canlı ekran bu hatayla da çalışmaya devam eder;');
            console.error('   yalnızca veriler Redis\'e kalıcı olarak yazılmaz.');
            console.error('');
        } else {
            console.error('⚠️  Redis yazma testi başarısız:', err.message);
        }
    }
});

app.use(express.json({ limit: '64kb' })); // telemetri gövdesi küçüktür; büyük gövdeyi baştan reddet
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // index.html buradan servis edilir

/* ---- [DEĞİŞİKLİK 3] Sıcak yol (hot path) durumu ---------------------------
 * Mimarinin özü: HTTP isteği SADECE belleğe yazar. Redis'e yazma ve tarayıcıya
 * yayın, aşağıdaki zamanlayıcılarda toplu (batch) yapılır.
 * Neden: saniyede 450 istek x (1 Redis gidiş-dönüşü + istemci sayısı kadar WS
 * paketi) sürdürülebilir değil. Toplu işleyince 450 Redis çağrısı 10 pipeline'a,
 * 450 WS paketi 5 pakete iner.
 * -------------------------------------------------------------------------- */
const sonDurum = new Map();      // vehicleId -> en güncel telemetri (tek doğruluk kaynağı)
const kirliKayitlar = new Set(); // son Redis flush'ından beri değişen vehicleId'ler
const yayinKuyrugu = new Set();  // son WS yayınından beri değişen vehicleId'ler

// Ekrandaki istatistik kutularını besleyen sayaçlar
let toplamIstek = 0;
let sonSaniyedekiIstek = 0;
let saniyelikSayac = 0;
let redisYazmaHatasi = 0;

const REDIS_FLUSH_MS = 100;    // Redis'e toplu yazma aralığı (saniyede 10 pipeline)
const YAYIN_MS = 200;          // Tarayıcıya yayın aralığı (saniyede 5 paket)
const ARAC_TTL_SN = 300;       // Redis'teki araç kaydının ömrü — ölü araçlar kendiliğinden silinsin
const MAX_WS_BUFFER = 1 << 20; // 1MB: yavaş istemciye veri yığıp belleği şişirmeyelim

/* ---- Telemetri girişi ---------------------------------------------------- */
// [DEĞİŞİKLİK 4] Handler'dan "async" ve "await redis.hset(...)" KALDIRILDI.
// ÖNCE : async handler -> await redis.hset -> hata -> catch -> 500 -> yayın yok.
//        Ekranın akması Redis'in sağlığına bağlıydı. Asıl hatanın ekrana
//        yansıma biçimi tam olarak buydu.
// SONRA: senkron, Redis'e hiç dokunmuyor. Redis tamamen çökse bile bu uç 200
//        döner ve canlı ekran akmaya devam eder.
app.post('/api/telemetry', (req, res) => {
    const { vehicleId, lat, lon, speed } = req.body || {};

    if (!vehicleId) {
        return res.status(400).json({ error: 'vehicleId zorunludur.' });
    }

    // Number(): gövde JSON değil de form-urlencoded gelirse alanlar string olur.
    // Tarayıcıda toFixed(5) çağırdığımız için sayıya burada normalize ediyoruz.
    const kayit = {
        vehicleId,
        lat: Number(lat),
        lon: Number(lon),
        speed: Number(speed),
        updatedAt: Date.now()
    };

    // Aynı aracın yeni verisi eskisinin üstüne yazılır (Map, vehicleId ile anahtarlı).
    // Bu yüzden 200 ms içinde 3 kez güncellenen araç tarayıcıya 3 değil 1 satır gider.
    sonDurum.set(vehicleId, kayit);
    kirliKayitlar.add(vehicleId);
    yayinKuyrugu.add(vehicleId);
    toplamIstek++;
    saniyelikSayac++;

    res.status(200).json({ status: 'success' });
});

// [DEĞİŞİKLİK 5] YENİ UÇ — Redis katmanının okunduğu yer.
// Eski kodda Redis'e sadece YAZILIYOR, hiç OKUNMUYORDU; yani Redis katmanı
// sistemde fiilen ölü bir yazma hedefiydi. Bu uç, verinin gerçekten Redis'e
// düştüğünü doğrulamayı da sağlar (doğrulamada 500 araç okundu).
app.get('/api/vehicles', async (req, res) => {
    try {
        // KEYS değil SCAN: KEYS tek seferde tüm anahtar uzayını tarayıp
        // Redis'i bloklar. SCAN imleçle parça parça ilerler.
        const anahtarlar = [];
        let cursor = '0';
        do {
            const [yeniCursor, bulunan] = await redis.scan(cursor, 'MATCH', 'vehicle:*', 'COUNT', 500);
            cursor = yeniCursor;
            anahtarlar.push(...bulunan);
        } while (cursor !== '0');

        // 500 ayrı hgetall yerine tek pipeline
        const pipeline = redis.pipeline();
        anahtarlar.forEach((k) => pipeline.hgetall(k));
        const sonuclar = await pipeline.exec();

        const araclar = sonuclar
            .map(([err, veri], i) => (err ? null : { vehicleId: anahtarlar[i].slice('vehicle:'.length), ...veri }))
            .filter(Boolean);

        res.json({ count: araclar.length, vehicles: araclar });
    } catch (error) {
        res.status(503).json({ error: 'Redis okunamadi: ' + error.message });
    }
});

// [DEĞİŞİKLİK 6] YENİ UÇ — teşhis. Bu iş baştan "ekran boş, sebebi belirsiz"
// diye zaman kaybettirdi; artık sistemin durumu tek istekle görülebiliyor.
app.get('/api/health', (req, res) => {
    res.json({
        redis: redis.status,          // 'ready' değilse sorun Redis'tedir
        vehicles: sonDurum.size,
        clients: wss.clients.size,    // 0 ise tarayıcı hiç bağlanmamış demektir
        reqPerSec: sonSaniyedekiIstek,
        totalRequests: toplamIstek
    });
});

/* ---- [DEĞİŞİKLİK 7] Redis'e toplu yazma ----------------------------------
 * ÖNCE : her istekte tek tek "await redis.hset(...)" -> saniyede 450 ağ
 *        gidiş-dönüşü ve her birinin gecikmesi HTTP yanıtına ekleniyordu.
 * SONRA: 100 ms'de bir pipeline. O aralıkta 45 istek geldiyse ve bunlar 40
 *        farklı araçsa, tek pakette 40 hset gider. Ayrıca aynı araç aralıkta
 *        5 kez güncellendiyse Redis'e 5 değil 1 yazma yapılır.
 * ------------------------------------------------------------------------- */
setInterval(() => {
    // redis.status !== 'ready' kontrolü: bağlantı yokken pipeline kurup
    // boşuna hata üretmeyelim. Kayıtlar kirliKayitlar'da bekler, bağlantı
    // geri gelince yazılır — veri kaybolmaz.
    if (kirliKayitlar.size === 0 || redis.status !== 'ready') return;

    const pipeline = redis.pipeline();
    for (const vehicleId of kirliKayitlar) {
        const v = sonDurum.get(vehicleId);
        if (!v) continue; // temizlik zamanlayıcısı bu aracı düşürmüş olabilir
        const anahtar = `vehicle:${vehicleId}`;
        pipeline.hset(anahtar, 'lat', v.lat, 'lon', v.lon, 'speed', v.speed, 'updatedAt', v.updatedAt);
        pipeline.expire(anahtar, ARAC_TTL_SN); // yayın yapmayan araç Redis'te sonsuza kadar kalmasın
    }
    kirliKayitlar.clear();

    // .catch() ZORUNLU: yakalanmamış promise reddi Node'u çökertebilir.
    // Hata yalnızca sayılır ve loglanır — canlı ekranı asla durdurmaz.
    pipeline.exec().catch((err) => {
        redisYazmaHatasi++;
        if (Date.now() - sonRedisHatasi > 1000) {
            sonRedisHatasi = Date.now();
            console.error('⚠️  Redis yazma hatası:', err.message);
        }
    });
}, REDIS_FLUSH_MS);

/* ---- [DEĞİŞİKLİK 8] Tarayıcıya toplu yayın ------------------------------- */
function yayinla(paket) {
    // JSON.stringify bir kez yapılır, tüm istemcilere aynı string gider.
    // Eski kodda her istekte yeniden stringify ediliyordu.
    const veri = JSON.stringify(paket);
    wss.clients.forEach((client) => {
        if (client.readyState !== client.OPEN) return;
        // Geri basınç (backpressure): istemci verimizi tüketemiyorsa sunucunun
        // belleğinde kuyruk büyür. Böyle bir istemciyi o tur atlıyoruz.
        if (client.bufferedAmount > MAX_WS_BUFFER) return;
        client.send(veri);
    });
}

setInterval(() => {
    if (wss.clients.size === 0) return; // kimse izlemiyorsa paket üretme

    // ÖNCE : POST handler'ının içinde, istek başına bir WS paketi.
    //        450 istek/sn x N istemci = 450N paket/sn.
    // SONRA: 200 ms'de bir paket -> 5 paket/sn. İçinde sadece o aralıkta
    //        DEĞİŞEN araçlar var; her araç pakette en fazla bir kez geçer.
    // Ölçüm: 4514 istek -> 3889 satır (tekrar eden güncellemeler sıkıştı).
    const araclar = [];
    for (const vehicleId of yayinKuyrugu) {
        const v = sonDurum.get(vehicleId);
        if (v) araclar.push(v);
    }
    yayinKuyrugu.clear();

    yayinla({
        type: 'batch',
        vehicles: araclar,
        stats: { // ekrandaki istatistik kutuları bu alandan beslenir
            reqPerSec: sonSaniyedekiIstek,
            totalRequests: toplamIstek,
            activeVehicles: sonDurum.size,
            clients: wss.clients.size,
            redis: redis.status,
            redisErrors: redisYazmaHatasi
        }
    });
}, YAYIN_MS);

// Saniyelik istek hızını hesapla: sayaç okunur ve sıfırlanır.
setInterval(() => {
    sonSaniyedekiIstek = saniyelikSayac;
    saniyelikSayac = 0;
}, 1000);

// [DEĞİŞİKLİK 9] Bellek temizliği. sonDurum Map'i her yeni vehicleId ile
// büyür; uzun süren bir simülasyonda bu kalıcı bellek sızıntısıdır.
// Redis'teki EXPIRE'ın bellekteki karşılığı.
setInterval(() => {
    const sinir = Date.now() - ARAC_TTL_SN * 1000;
    for (const [id, v] of sonDurum) {
        if (v.updatedAt < sinir) sonDurum.delete(id);
    }
}, 30000);

/* ---- WebSocket ----------------------------------------------------------- */
wss.on('connection', (ws) => {
    console.log(`🟢 Tarayıcı bağlandı (toplam istemci: ${wss.clients.size})`);

    // [DEĞİŞİKLİK 10] Anlık görüntü (snapshot).
    // ÖNCE : yeni sekme yalnızca "veriler bekleniyor" mesajı alırdı; simülasyon
    //        o an çalışmıyorsa ekran boş kalır, kullanıcı sistemi bozuk sanırdı.
    // SONRA: bağlanan istemci bilinen tüm filoyu anında alır.
    ws.send(JSON.stringify({
        type: 'snapshot',
        vehicles: Array.from(sonDurum.values()),
        message: 'WebSocket köprüsü aktif, veriler bekleniyor...'
    }));

    ws.on('close', () => console.log(`🔴 Tarayıcı ayrıldı (kalan istemci: ${wss.clients.size})`));
    // Tek bir sekmenin kopması sunucuyu ilgilendirmez; dinleyici yoksa Node çöker.
    ws.on('error', () => { /* yoksayılır */ });
});

// [DEĞİŞİKLİK 11] İstek başına console.log KALDIRILDI.
// Eski kodda her istekte istemci sayısı basılıyordu: saniyede 450 satır log.
// Terminale yazmak senkron bir I/O işlemidir ve tek başına ciddi yük bindirir.
// İstenen de zaten "terminale değil, ekrana" yönündeydi.

// Port da ortam değişkeninden okunur: 3000 meşgulse PORT=3001 npm start yeter.
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Sunucu http://localhost:${PORT} adresinde ayakta!`);
    console.log('   Önce tarayıcıda bu adresi açın, sonra "npm run sim" çalıştırın.');
});

// 3000 portu başka bir uygulamadaysa hatayı anlaşılır hale getir.
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ ${PORT} portu zaten kullanımda.`);
        console.error(`   Ya o uygulamayı kapatın ya da: PORT=3001 npm start`);
        process.exit(1);
    }
    throw err;
});

// [DEĞİŞİKLİK 12] Düzgün kapanış: Ctrl+C'de soketler kapatılır ve Redis
// bağlantısı bırakılır. Aksi halde port bir süre meşgul kalabiliyor.
process.on('SIGINT', () => {
    console.log('\nKapatılıyor...');
    wss.clients.forEach((c) => c.close());
    server.close(() => redis.quit().finally(() => process.exit(0)));
});
