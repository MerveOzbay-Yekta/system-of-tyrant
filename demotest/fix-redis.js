/* ============================================================================
 * fix-redis.js — "MISCONF" hatasını teşhis eder ve giderir
 * ============================================================================
 *
 * NE İŞE YARAR?
 * Redis, RDB snapshot dosyasını diske yazamadığında kendini koruma moduna alır
 * ve TÜM yazma komutlarını reddeder:
 *     MISCONF Redis is configured to save RDB snapshots, but it is currently
 *     not able to persist on disk...
 * Bu projede tam olarak bu yaşandı: Redis'in "dir" ayarı sürücü kökünü (C:\)
 * gösteriyordu ve Windows 11'de orası yönetici izni olmadan yazılamıyordu.
 * Sonuç: /api/telemetry ucu 500 döndürüyor, canlı ekrana tek satır düşmüyordu.
 *
 * BU BETİK NE DEĞİŞTİRİR?
 *     CONFIG SET stop-writes-on-bgsave-error no   -> snapshot hatası yazmayı kilitlemesin
 *     CONFIG SET save ""                          -> periyodik snapshot kapansın
 *
 * NEDEN GÜVENLİ?
 * - Bu bir yük simülatörüdür; araç konumları anlıktır, kalıcı olması gerekmez.
 *   Kayıtların zaten 300 saniyelik TTL'i var, yani kalıcılık baştan hedef değil.
 * - Saniyede ~450 yazma altında RDB fork'u ayrıca gereksiz yük bindirir.
 * - Değişiklik yalnızca ÇALIŞMA ANINDA geçerlidir; redis-server yeniden
 *   başlayınca eski ayarlara döner. Kalıcı bir şey bozmaz.
 *
 * DİKKAT: Bu Redis'i başka bir iş için de kullanıyorsanız ve gerçekten
 * kalıcılığa ihtiyacınız varsa bu betiği çalıştırmayın. Onun yerine "dir"
 * ayarını yazma izni olan bir klasöre alın (aşağıda nasıl yapılacağı yazıyor).
 * ========================================================================= */

const Redis = require('ioredis');

const redisAyarlari = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null // Redis yoksa sonsuza kadar deneme, hemen bildir
};
const redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, redisAyarlari)
    : new Redis(redisAyarlari);

redis.on('error', () => { /* aşağıda anlamlı mesaj basılıyor, burayı sustur */ });

// enableOfflineQueue kapalı olduğu için bağlantı kurulmadan komut gönderilemez
// ("Stream isn't writeable" hatası). Bu yüzden önce 'ready' olayını bekliyoruz.
function baglantiyiBekle(zamanAsimiMs = 5000) {
    return new Promise((coz, reddet) => {
        if (redis.status === 'ready') return coz();
        const sayac = setTimeout(() => {
            temizle();
            reddet(new Error(`Bağlantı ${zamanAsimiMs} ms içinde kurulamadı`));
        }, zamanAsimiMs);
        const basarili = () => { temizle(); coz(); };
        const basarisiz = (err) => { temizle(); reddet(err); };
        function temizle() {
            clearTimeout(sayac);
            redis.off('ready', basarili);
            redis.off('error', basarisiz);
            redis.off('end', sonlandi);
        }
        const sonlandi = () => basarisiz(new Error('Bağlantı kurulamadan kapandı'));
        redis.once('ready', basarili);
        redis.once('error', basarisiz);
        redis.once('end', sonlandi);
    });
}

// CONFIG GET ["anahtar","deger"] biçiminde dizi döner; değeri ayıklar.
async function ayarOku(anahtar) {
    const sonuc = await redis.config('GET', anahtar);
    return sonuc && sonuc.length > 1 ? sonuc[1] : '(okunamadı)';
}

// Gerçek bir yazma denemesi. Tek güvenilir test budur: CONFIG okumak
// çalışsa bile yazma kilitli olabilir.
async function yazmaTesti() {
    try {
        await redis.set('gateway:fixcheck', Date.now(), 'EX', 30);
        await redis.del('gateway:fixcheck');
        return { ok: true };
    } catch (err) {
        return { ok: false, mesaj: err.message };
    }
}

(async () => {
    console.log('🔍 Redis teşhisi başlıyor...\n');

    try {
        await baglantiyiBekle();
        await redis.ping();
    } catch (err) {
        console.error('❌ Redis\'e bağlanılamadı:', err.message);
        console.error(`   Denenen adres: ${redisAyarlari.host}:${redisAyarlari.port}`);
        console.error('   Redis kurulu ve çalışıyor mu? Kurulum için README.md bölüm 2.');
        process.exit(1);
    }

    // --- Mevcut durum ---
    const dir = await ayarOku('dir');
    const save = await ayarOku('save');
    const stopWrites = await ayarOku('stop-writes-on-bgsave-error');
    const persistence = await redis.info('persistence');
    const bgsaveDurumu = (persistence.match(/rdb_last_bgsave_status:(\w+)/) || [])[1];

    console.log('   dir                          :', dir);
    console.log('   save                         :', save === '' ? '(kapalı)' : save);
    console.log('   stop-writes-on-bgsave-error  :', stopWrites);
    console.log('   rdb_last_bgsave_status       :', bgsaveDurumu);
    console.log('');

    const oncesi = await yazmaTesti();

    if (oncesi.ok) {
        console.log('✅ Redis zaten yazabiliyor. Yapılacak bir şey yok.');
        console.log('   "npm start" ile sunucuyu başlatabilirsiniz.');
        await redis.quit();
        return;
    }

    console.log('❌ Redis yazmayı reddediyor:');
    console.log('   ' + oncesi.mesaj);
    console.log('');

    if (!/MISCONF/.test(oncesi.mesaj)) {
        // Beklediğimiz hata değilse kendi başımıza ayar değiştirmeyelim.
        console.log('⚠️  Bu, bu betiğin onarmayı bildiği MISCONF hatası değil.');
        console.log('   Ayar değiştirilmedi. Yukarıdaki mesajı inceleyin.');
        await redis.quit();
        process.exit(1);
    }

    console.log('🔧 Onarılıyor (yalnızca çalışma anı ayarı):');
    console.log('   CONFIG SET stop-writes-on-bgsave-error no');
    console.log('   CONFIG SET save ""');
    console.log('');

    await redis.config('SET', 'stop-writes-on-bgsave-error', 'no');
    await redis.config('SET', 'save', '');

    const sonrasi = await yazmaTesti();

    if (!sonrasi.ok) {
        console.error('❌ Onarım işe yaramadı:', sonrasi.mesaj);
        console.error('   Redis günlüklerini inceleyin.');
        await redis.quit();
        process.exit(1);
    }

    console.log('✅ Onarıldı. Redis artık yazabiliyor.');
    console.log('   "npm start" ile sunucuyu başlatabilirsiniz.');
    console.log('');
    console.log('ℹ️  Bu değişiklik redis-server yeniden başlayınca kaybolur.');
    console.log('   Kalıcı olması için redis.conf dosyasına şunları ekleyin:');
    console.log('       save ""');
    console.log('       stop-writes-on-bgsave-error no');
    console.log('   Snapshot almayı gerçekten istiyorsanız alternatif olarak');
    console.log('   "dir" ayarını yazma izni olan bir klasöre alın:');
    console.log('       dir C:/redis-data');

    await redis.quit();
})().catch((err) => {
    console.error('Beklenmeyen hata:', err.message);
    process.exit(1);
});
