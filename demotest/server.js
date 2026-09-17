const express = require('express');
const Redis = require('ioredis');

const app = express();
const redis = new Redis(); // localhost:6379'a bağlanır

// Gelen JSON gövdelerini okuyabilmek için middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Araçtan gelen veriyi karşılayan endpoint
app.post('/api/telemetry', async (req, res) => {
    try {
        const { vehicleId, lat, lon, speed } = req.body;

        if (!vehicleId) {
            return res.status(400).json({ error: 'vehicleId zorunludur.' });
        }

        // Redis Hash kullanarak aracın son durumunu RAM'e yazıyoruz
        await redis.hset(
            `vehicle:${vehicleId}`,
            'lat', lat,
            'lon', lon,
            'speed', speed,
            'updatedAt', Date.now()
        );

        return res.status(200).json({ status: 'success' });
    } catch (error) {
        console.error('Hata:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Aracın anlık konumunu sorgulama endpoint'i
app.get('/api/vehicle/:id', async (req, res) => {
    try {
        const vehicleId = req.params.id;
        const data = await redis.hgetall(`vehicle:${vehicleId}`);
        
        if (!data || Object.keys(data).length === 0) {
            return res.status(404).json({ error: 'Araç bulunamadı.' });
        }

        return res.json(data);
    } catch (error) {
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Araç Takip Gateway Servisi ${PORT} portunda ayakta!`);
});