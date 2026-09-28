const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3002;
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(path.join(__dirname, 'output')));

const API_KEY = "AQ.Ab8RN6LXQSIZXfTZZ2EnbiWdTEZx58E4VfJCXascJnDEHqkDGw"; 
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-image-preview" });
const WEATHER_API_KEY = "263d719aa371d7a5d88ac6aa7b2d2d26";

// Simple JSON File Database Helper
const dbFile = path.join(__dirname, 'wardrobe.json');
function getDB() {
    if (!fs.existsSync(dbFile)) {
        fs.writeFileSync(dbFile, JSON.stringify({ wardrobe: [], history: [] }));
    }
    return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
}
function saveDB(data) {
    fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
}

// 1. Virtual Try-On
app.post('/api/synthesize-tryon', upload.fields([{ name: 'userPhoto', maxCount: 1 }, { name: 'outfitPhoto', maxCount: 1 }]), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const userPhoto = req.files.userPhoto[0];
        const outfitPhoto = req.files.outfitPhoto[0];
        const result = await model.generateContent([
            { inlineData: { data: userPhoto.buffer.toString('base64'), mimeType: userPhoto.mimetype } },
            { inlineData: { data: outfitPhoto.buffer.toString('base64'), mimeType: outfitPhoto.mimetype } },
            "Generate a photorealistic image of the person from the first image wearing the exact outfit from the second image."
        ]);
        const imageBuffer = Buffer.from(result.response.image().asBase64(), 'base64');
        const fileName = `tryon_${Date.now()}.png`;
        fs.writeFileSync(path.join(__dirname, 'output', fileName), imageBuffer);
        res.json({ success: true, imageUrl: `/output/${fileName}` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Wardrobe Endpoints
app.post('/api/upload-wardrobe', upload.single('itemImage'), (req, res) => {
    const fileName = `wardrobe_${Date.now()}.png`;
    fs.writeFileSync(path.join(__dirname, 'output', fileName), req.file.buffer);
    const dbData = getDB();
    dbData.wardrobe.push({ imageUrl: `/output/${fileName}`, category: req.body.category || 'general' });
    saveDB(dbData);
    res.redirect('/wardrobe.html');
});

app.get('/api/wardrobe-items', (req, res) => {
    const dbData = getDB();
    res.json({ success: true, items: dbData.wardrobe });
});

// 3. Weather OOTD
app.post('/api/daily-ootd-weather', upload.single('userPhoto'), async (req, res) => {
    try {
        const weatherRes = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Kumanovo&units=metric&appid=${WEATHER_API_KEY}`);
        const wData = await weatherRes.json();
        const temp = wData.main ? `${Math.round(wData.main.temp)}°C` : "18°C";
        const dbData = getDB();
        const img = dbData.wardrobe[0]?.imageUrl || '/output/default.png';
        res.json({ success: true, imageUrl: img, weatherInfo: `Kumanovo: ${temp}`, description: `Dressed for current temperature of ${temp}.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Fashion Coach
app.post('/api/rate-outfit', upload.single('outfitCheckPhoto'), async (req, res) => {
    const result = await model.generateContent([
        { inlineData: { data: req.file.buffer.toString('base64'), mimeType: req.file.mimetype } },
        "Rate this outfit out of 10 and give two style tips."
    ]);
    res.json({ success: true, critique: result.response.text() });
});

// 5. Packing List
app.post('/api/generate-packing-list', express.json(), async (req, res) => {
    const dbData = getDB();
    const result = await model.generateContent(`Create a capsule packing list for ${req.body.destination} for ${req.body.duration}. Style: ${req.body.style}. Closet: ${JSON.stringify(dbData.wardrobe)}`);
    res.json({ success: true, packingList: result.response.text() });
});

// 6. Thrift Finder
app.post('/api/thrift-finder', express.json(), async (req, res) => {
    const result = await model.generateContent(`Find European second-hand thrift options and price estimates for: ${req.body.itemDescription}`);
    res.json({ success: true, results: result.response.text() });
});

// 7. Mood Board
app.post('/api/moodboard-tracker', upload.single('moodBoardImage'), async (req, res) => {
    const result = await model.generateContent([
        { inlineData: { data: req.file.buffer.toString('base64'), mimeType: req.file.mimetype } },
        "Analyze aesthetic trend keywords and color palette."
    ]);
    res.json({ success: true, analysis: result.response.text() });
});

// 8. Color Analysis
app.post('/api/analyze-colors', upload.single('selfie'), async (req, res) => {
    const result = await model.generateContent([
        { inlineData: { data: req.file.buffer.toString('base64'), mimeType: req.file.mimetype } },
        "Analyze facial features, hair, and eye color to determine exact Seasonal Color Palette."
    ]);
    res.json({ success: true, analysis: result.response.text() });
});

// 9. Calendar History
app.post('/api/log-outfit', express.json(), (req, res) => {
    const dbData = getDB();
    dbData.history.push(req.body);
    saveDB(dbData);
    res.json({ success: true });
});

app.get('/api/outfit-history', (req, res) => {
    const dbData = getDB();
    res.json({ success: true, history: dbData.history });
});

app.listen(port, () => console.log(`✨ Server running on port ${port}`));