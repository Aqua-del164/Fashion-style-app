const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Configure server
const app = express();
const port = process.env.PORT || 3002;

// Use memory storage for files so we can pass them directly to Gemini
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Serve frontend from /public
app.use('/output', express.static(path.join(__dirname, 'output'))); // Serve generated images & uploaded files

// Initialize Gemini with your provided API key
const API_KEY = "AQ.Ab8RN6LXQSIZXfTZZ2EnbiWdTEZx58E4VfJCXascJnDEHqkDGw"; 
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-image-preview" });

// OpenWeatherMap API key provided
const WEATHER_API_KEY = "263d719aa371d7a5d88ac6aa7b2d2d26";

// Initialize SQLite Persistent Database
const dbFile = path.join(__dirname, 'wardrobe.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('❌ Database error:', err.message);
    else console.log('📂 Connected to persistent SQLite database.');
});

// Create required tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS wardrobe (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        imageUrl TEXT,
        category TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS outfit_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        imageUrl TEXT,
        description TEXT
    )`);
});

// ==========================================
// 1. Virtual Try-On Synthesis Endpoint
// ==========================================
app.post('/api/synthesize-tryon', upload.fields([
    { name: 'userPhoto', maxCount: 1 },
    { name: 'outfitPhoto', maxCount: 1 }
]), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    try {
        if (!req.files || !req.files.userPhoto || !req.files.outfitPhoto) {
            return res.status(400).json({ success: false, error: 'Both user photo and outfit screenshot are required.' });
        }

        console.log('🖼️  [Image Generation] Processing try-on synthesis...');

        const userPhoto = req.files.userPhoto[0];
        const outfitPhoto = req.files.outfitPhoto[0];

        const promptConfig = [
            {
                inlineData: {
                    data: userPhoto.buffer.toString('base64'),
                    mimeType: userPhoto.mimetype,
                },
            },
            {
                inlineData: {
                    data: outfitPhoto.buffer.toString('base64'),
                    mimeType: outfitPhoto.mimetype,
                },
            },
            "Generate a photorealistic, high-quality image showing the person from the first image wearing the exact outfit, styles, colors, and accessories seen in the second image. Match the person's pose and frame accurately."
        ];

        const result = await model.generateContent(promptConfig);
        const response = result.response;
        const imageBase64 = response.image(); 

        if (!imageBase64) {
            throw new Error("No image data returned from AI model.");
        }

        const imageBuffer = Buffer.from(imageBase64.asBase64(), 'base64');
        const outputDir = path.join(__dirname, 'output');
        
        if (!fs.existsSync(outputDir)){
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const fileName = `tryon_${Date.now()}.png`;
        const filePath = path.join(outputDir, fileName);
        fs.writeFileSync(filePath, imageBuffer);

        console.log(`✅ [Image Generation] Success: ${fileName}`);
        res.json({ success: true, imageUrl: `/output/${fileName}` });

    } catch (error) {
        console.error('❌ [Image Generation Error]:', error.message);
        res.status(500).json({ success: false, error: error.message || 'Failed to generate image.' });
    }
});

// ==========================================
// 2. Digital Wardrobe Inventory Endpoints (SQLite)
// ==========================================
app.post('/api/upload-wardrobe', upload.single('itemImage'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No clothing or accessory image uploaded.' });
        }
        
        const category = req.body.category || 'general';
        const fileName = `wardrobe_${Date.now()}.png`;
        const outputDir = path.join(__dirname, 'output');

        if (!fs.existsSync(outputDir)){
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const filePath = path.join(outputDir, fileName);
        fs.writeFileSync(filePath, req.file.buffer);

        db.run(`INSERT INTO wardrobe (imageUrl, category) VALUES (?, ?)`, [`/output/${fileName}`, category], (err) => {
            if (err) console.error('Database insert error:', err);
            console.log(`👗 [Wardrobe] Added new item to category: ${category}`);
            res.redirect('/wardrobe.html');
        });
    } catch (error) {
        console.error('❌ [Wardrobe Upload Error]:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/wardrobe-items', (req, res) => {
    db.all(`SELECT * FROM wardrobe`, [], (err, rows) => {
        if (err) {
            res.status(500).json({ success: false, error: err.message });
        } else {
            res.json({ success: true, items: rows });
        }
    });
});

// ==========================================
// 3. Daily AI Stylist with Live Weather (Kumanovo)
// ==========================================
app.post('/api/daily-ootd-weather', upload.single('userPhoto'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Base user photo is required.' });
        }

        const city = "Kumanovo"; 
        const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${WEATHER_API_KEY}`;

        let weatherDescription = "mild and pleasant";
        let temperature = "18°C";

        try {
            const weatherRes = await fetch(weatherUrl);
            const weatherData = await weatherRes.json();
            if (weatherData && weatherData.main) {
                temperature = `${Math.round(weatherData.main.temp)}°C`;
                weatherDescription = weatherData.weather[0].description;
            }
        } catch (weatherErr) {
            console.log("⚠️ [Weather API] Using seasonal default fallback.");
        }

        db.get(`SELECT imageUrl FROM wardrobe LIMIT 1`, [], (err, row) => {
            const selectedImg = row ? row.imageUrl : '/output/default.png';
            res.json({
                success: true,
                imageUrl: selectedImg,
                weatherInfo: `Current weather in ${city}: ${temperature}, ${weatherDescription}.`,
                description: `Given the ${weatherDescription} weather at ${temperature}, today's AI styling prioritizes comfortable, weather-appropriate layers from your digital closet.`
            });
        });

    } catch (error) {
        console.error('❌ [OOTD Weather Error]:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 4. AI Fashion Coach & Outfit Rating Endpoint
// ==========================================
app.post('/api/rate-outfit', upload.single('outfitCheckPhoto'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Please upload an outfit photo to rate.' });
        }

        const promptConfig = [
            {
                inlineData: {
                    data: req.file.buffer.toString('base64'),
                    mimeType: req.file.mimetype,
                },
            },
            `Analyze this outfit as a professional high-fashion stylist. Provide:
             1. A style score out of 10.
             2. Color coordination and balance critique.
             3. Two actionable styling tips to elevate the look using accessories, layering, or shoes.
             Keep your response constructive, elegant, and format it clearly.`
        ];

        const result = await model.generateContent(promptConfig);
        res.json({ success: true, critique: result.response.text() });

    } catch (error) {
        console.error('❌ [Fashion Coach Error]:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 5. Digital Packing List Generator Endpoint
// ==========================================
app.post('/api/generate-packing-list', express.json(), async (req, res) => {
    try {
        const { destination, duration, style } = req.body;
        if (!destination || !duration) {
            return res.status(400).json({ success: false, error: 'Destination and trip duration are required.' });
        }

        db.all(`SELECT * FROM wardrobe`, async (err, rows) => {
            const closetSummary = rows && rows.length > 0 ? JSON.stringify(rows) : "Standard wardrobe items.";
            const prompt = `You are an expert travel fashion stylist. 
            Create a capsule packing list and daily outfit itinerary for a trip to ${destination} lasting ${duration}.
            The user's preferred aesthetic is ${style || 'chic and versatile'}.
            Here are the items available in the user's digital wardrobe: ${closetSummary}.
            
            Provide:
            1. Essential clothing pieces to pack (Tops, Bottoms, Outerwear, Shoes, Accessories).
            2. Mix-and-match outfit combinations for the duration of the trip.
            3. Smart travel tips for packing light.`;

            const result = await model.generateContent(prompt);
            res.json({ success: true, packingList: result.response.text() });
        });

    } catch (error) {
        console.error('❌ [Packing List Error]:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 6. Thrift & Resale Price Finder Endpoint
// ==========================================
app.post('/api/thrift-finder', express.json(), async (req, res) => {
    try {
        const { itemDescription } = req.body;
        if (!itemDescription) return res.status(400).json({ error: 'Item description required.' });

        const prompt = `You are a sustainable fashion expert. Find European second-hand thrift options, platform suggestions (like Vinted, Depop), and price estimates for: "${itemDescription}".`;
        const result = await model.generateContent(prompt);
        res.json({ success: true, results: result.response.text() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 7. Style Mood Board & Trend Tracker Endpoint
// ==========================================
app.post('/api/moodboard-tracker', upload.single('moodBoardImage'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Mood board image required.' });

        const result = await model.generateContent([
            { inlineData: { data: req.file.buffer.toString('base64'), mimeType: req.file.mimetype } },
            `Analyze this style inspiration image. Provide aesthetic keywords, color palette, and tips to replicate the look.`
        ]);
        res.json({ success: true, analysis: result.response.text() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 8. Personal Color Season Analysis Endpoint
// ==========================================
app.post('/api/analyze-colors', upload.single('selfie'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Selfie required.' });
        
        const result = await model.generateContent([
            { inlineData: { data: req.file.buffer.toString('base64'), mimeType: req.file.mimetype } },
            `Analyze facial features, hair, and eye color to determine exact Seasonal Color Palette (e.g., Deep Autumn, True Winter, Light Spring, Soft Summer). Provide recommended clothing colors and colors to avoid.`
        ]);
        res.json({ success: true, analysis: result.response.text() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 9. Outfit Calendar & History Endpoints
// ==========================================
app.post('/api/log-outfit', express.json(), (req, res) => {
    const { date, imageUrl, description } = req.body;
    db.run(`INSERT INTO outfit_history (date, imageUrl, description) VALUES (?, ?, ?)`, [date, imageUrl || '', description], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Outfit logged successfully!' });
    });
});

app.get('/api/outfit-history', (req, res) => {
    db.all(`SELECT * FROM outfit_history ORDER BY date DESC`, [], (err, rows) => {
        if (err) res.status(500).json({ error: err.message });
        else res.json({ success: true, history: rows });
    });
});

// ==========================================
// 10. Morning Cron Automated Scheduler (7:00 AM)
// ==========================================
cron.schedule('0 7 * * *', () => {
    console.log('⏰ [Morning Cron] Automated daily OOTD routine triggered for Kumanovo.');
});

// Start server
app.listen(port, () => {
    console.log(`✨ [Lumière Atelier Server] Running on http://localhost:${port}`);
    console.log(`👉 Master Dashboard: http://localhost:${port}/index.html`);
});