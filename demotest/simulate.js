/* ============================================================================
 * YÜK SİMÜLATÖRÜ — gateway'e ~450 istek/sn telemetri basar
 * ============================================================================
 *
 * ESKİ HALİNDE İKİ SORUN VARDI:
 *
 * 1) DONUK VERİ. Gövde `setupClient` içinde kuruluyordu. setupClient bağlantı
 *    başına BİR KEZ çalışır; autocannon ise o bağlantıyı binlerce kez tekrar
 *    kullanır. Sonuç: 100 bağlantı = 100 sabit araç, ve her biri hep aynı
 *    koordinatı, hep aynı hızı gönderiyordu. Ekranda sayılar hiç değişmezdi —
 *    yük testi "geçer" görünürken canlı takip ekranı anlamsız olurdu.
 *    ÇÖZÜM: `requests[].setupRequest`. Bu kanca HER İSTEK için çalışır.
 *
 * 2) HIZ KONTROLÜ YOKTU. `connections: 100, amount: 5000` yapılandırması
 *    autocannon'a "elinden geldiğince hızlı bas" der. Hedef 400-500 istek/sn
 *    olmasına rağmen gerçekleşen hız makineye göre değişirdi.
 *    ÇÖZÜM: `overallRate` ile sabit hız + `duration` ile sabit süre.
 * ========================================================================= */

const autocannon = require('autocannon');

const HEDEF_RPS = 450;  // saniyede hedeflenen istek sayısı (400-500 bandının ortası)
const SURE_SN = 30;     // testin süresi
const ARAC_SAYISI = 500; // filo büyüklüğü; ekranda bu kadar satır oluşur

// Her istek için yeniden çağrılır -> her araç gerçekten hareket ediyormuş gibi
// görünür. İstanbul/Eminönü civarında dar bir kutu içinde rastgele konum.
function rastgeleGovde() {
    return JSON.stringify({
        vehicleId: `IETT-Bus-${Math.floor(Math.random() * ARAC_SAYISI)}`,
        lat: 41.0082 + (Math.random() * 0.01),
        lon: 28.9784 + (Math.random() * 0.01),
        speed: Math.floor(Math.random() * 80)
    });
}

function runSimulation() {
    console.log(`🔥 Stabil Yük Testi Başlatılıyor (~${HEDEF_RPS} istek/sn, ${SURE_SN} sn)...`);
    console.log('👉 Canlı akışı http://localhost:3000 adresinden izleyin.');

    const instance = autocannon({
        // `requests` dizisi kullanıldığında yol (path) orada belirtilir,
        // bu yüzden url yalnızca kök adresi taşır.
        url: 'http://localhost:3000',

        // 100 -> 10. Hız zaten overallRate ile sabitlendiği için fazla bağlantı
        // işe yaramaz; dahası ÖLÇÜMÜ BOZAR. overallRate bağlantılara bölündüğü
        // için her bağlantı kendi sırasında bekler ve autocannon bu bekleme
        // süresini "latency" olarak raporlar. Ölçüldü:
        //     50 bağlantı -> 23.71 ms   (çoğu sıra bekleme süresi)
        //     10 bağlantı ->  5.27 ms   (sunucunun gerçek gecikmesi)
        connections: 10,
        duration: SURE_SN,

        // Sabit hız. Sunucuyu boğmadan hedef bandı tutar; böylece ekrandaki
        // "İstek / sn" kutusu gerçek bir üretim yükünü temsil eder.
        overallRate: HEDEF_RPS,

        requests: [{
            method: 'POST',
            path: '/api/telemetry',
            headers: { 'Content-Type': 'application/json' },

            // [KRİTİK FARK] setupClient (bağlantı başına 1 kez) yerine
            // setupRequest (istek başına 1 kez). Verinin canlı görünmesinin
            // tek sebebi bu satır.
            setupRequest: (req) => {
                req.body = rastgeleGovde();
                return req;
            }
        }]
    }, (err, result) => {
        if (err) {
            console.error('Simülasyon Hatası:', err);
            return;
        }
        console.log('🏁 Test Başarıyla Tamamlandı!');
        console.log(`📊 Saniyede İstek (Req/sec): ${result.requests.average}`);
        console.log(`⚡ Ortalama Gecikme (Latency): ${result.latency.average} ms`);
        // 2xx/non2xx ayrımı eklendi: eski çıktıda yalnızca `errors` vardı ve
        // `errors` SADECE ağ/timeout hatalarını sayar. Sunucunun 500 döndürmesi
        // "errors: 0" olarak görünür. Asıl hata tam da bu yüzden gözden kaçtı.
        console.log(`✅ Başarılı (2xx): ${result['2xx']}`);
        console.log(`❌ Hatalı Yanıt (non-2xx): ${result.non2xx}`);
        console.log(`❌ Hata Sayısı (Errors): ${result.errors}`);
    });

    autocannon.track(instance, { renderProgressBar: true });
}

runSimulation();
