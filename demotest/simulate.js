const autocannon = require('autocannon');

function runSimulation() {
    console.log("🔥 Saniyede 400 istek simülasyonu başlatılıyor...");

    const instance = autocannon({
        url: 'http://localhost:3000/api/telemetry',
        connections: 100, // Eş zamanlı bağlantı havuzu
        amount: 4000,    // Toplam 4000 istek atılacak
        pipelining: 1,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        // Her istekte rastgele bir araç ID'si ve koordinat üretelim ki gerçekçi olsun
        setupClient: (client) => {
            client.setRequest({
                body: JSON.stringify({
                    vehicleId: `IETT-Bus-${Math.floor(Math.random() * 500)}`,
                    lat: 41.0082 + (Math.random() * 0.01),
                    lon: 28.9784 + (Math.random() * 0.01),
                    speed: Math.floor(Math.random() * 80)
                })
            });
        }
    }, (err, result) => {
        if (err) {
            console.error('Simülasyon Hatası:', err);
        } else {
            console.log('🏁 Simülasyon Tamamlandı!');
            console.log(`📊 Saniyede İstek (Req/sec): ${result.requests.average}`);
            console.log(`⚡ Ortalama Gecikme (Latency): ${result.latency.average} ms`);
        }
    });

    autocannon.track(instance, { renderProgressBar: true });
}

runSimulation();