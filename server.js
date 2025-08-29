const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const db = require('./database');
require('dotenv').config();

const app = express();
const port = 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});


// Add middleware
app.use(express.json());
app.use(cors());
const upload = multer({ dest: 'uploads/' });

// Try to load QuickBooks routes with verbose debugging
console.log('=== QuickBooks Module Loading Debug ===');
console.log('Current directory:', __dirname);
console.log('Looking for quickbooks.js...');

try {
  // Check if file exists first
  const quickbooksPath = './quickbooks.js';
  const absolutePath = path.join(__dirname, 'quickbooks.js');
  
  console.log('Checking path:', quickbooksPath);
  console.log('Absolute path:', absolutePath);
  console.log('File exists (relative)?', fs.existsSync(quickbooksPath));
  console.log('File exists (absolute)?', fs.existsSync(absolutePath));
  
  // List all .js files in current directory
  const jsFiles = fs.readdirSync('.').filter(f => f.endsWith('.js'));
  console.log('All .js files in directory:', jsFiles);
  
  if (fs.existsSync(quickbooksPath)) {
    console.log('quickbooks.js found, attempting to require...');
    const quickbooksRoutes = require('./quickbooks');
    console.log('QuickBooks module loaded, type:', typeof quickbooksRoutes);
    console.log('QuickBooks module is router?', quickbooksRoutes && quickbooksRoutes.name === 'router');
    
    app.use('/api/quickbooks', quickbooksRoutes);
    console.log('✅ QuickBooks routes mounted at /api/quickbooks');
  } else {
    console.error('❌ quickbooks.js file NOT found');
    // Add fallback route
    app.get('/api/quickbooks/status', (req, res) => {
      res.json({ 
        error: 'QuickBooks module not found',
        filesInDirectory: jsFiles
      });
    });
  }
} catch (error) {
  console.error('❌ Failed to load QuickBooks routes:', error.message);
  console.error('Full error:', error);
  // Add fallback route with error details
  app.get('/api/quickbooks/status', (req, res) => {
    res.json({ 
      error: 'QuickBooks module failed to load',
      message: error.message,
      stack: error.stack
    });
  });
}

console.log('=== End QuickBooks Debug ===');

const PRICING_DATABASE = {
  'lawn_installation': { rate: 0.75, unit: 'sq ft', description: 'New lawn installation' },
  'lawn_seeding': { rate: 0.35, unit: 'sq ft', description: 'Lawn seeding and prep' },
  'sod_installation': { rate: 1.25, unit: 'sq ft', description: 'Sod installation' },
  'paver_installation': { rate: 12, unit: 'sq ft', description: 'Paver installation with base prep' },
  'concrete_patio': { rate: 8, unit: 'sq ft', description: 'Concrete patio installation' },
  'mulch_installation': { rate: 0.85, unit: 'sq ft', description: 'Mulch installation' },
  'flower_bed_prep': { rate: 2.50, unit: 'sq ft', description: 'Flower bed preparation' },
  'retaining_wall': { rate: 25, unit: 'linear ft', description: 'Retaining wall installation' },
  'fence_installation': { rate: 35, unit: 'linear ft', description: 'Fence installation' },
  'deck_staining': { rate: 2.75, unit: 'sq ft', description: 'Deck cleaning and staining' },
  'drainage_repair': { rate: 85, unit: 'hour', description: 'Drainage system repair' },
  'sprinkler_repair': { rate: 75, unit: 'hour', description: 'Sprinkler system repair' },
  'tree_removal': { rate: 125, unit: 'hour', description: 'Tree removal service' },
  'bush_trimming': { rate: 65, unit: 'hour', description: 'Bush and shrub trimming' },
  'general_cleanup': { rate: 55, unit: 'hour', description: 'General landscape cleanup' },
  'weed_removal': { rate: 45, unit: 'hour', description: 'Weed removal and treatment' },
  'design_consultation': { rate: 150, unit: 'project', description: 'Landscape design consultation' },
  'soil_testing': { rate: 75, unit: 'project', description: 'Soil testing and analysis' },
  'permit_assistance': { rate: 200, unit: 'project', description: 'Permit application assistance' }
};

const MATERIAL_COSTS = {
  'sod': { cost: 0.45, unit: 'sq ft' },
  'mulch': { cost: 0.35, unit: 'sq ft' },
  'pavers': { cost: 4.50, unit: 'sq ft' },
  'concrete': { cost: 3.25, unit: 'sq ft' },
  'topsoil': { cost: 35, unit: 'cubic yard' },
  'gravel': { cost: 25, unit: 'cubic yard' },
  'sand': { cost: 20, unit: 'cubic yard' },
  'stone': { cost: 45, unit: 'cubic yard' },
  'lumber': { cost: 4.25, unit: 'linear ft' },
  'plants': { cost: 25, unit: 'each' }
};

// Authentication middleware
function authenticateWebhook(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const validKey = process.env.WEBHOOK_API_KEY;
  
  if (validKey && apiKey !== validKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  
  next();
}

async function analyzeConversation(transcription) {
  const prompt = `You are an expert landscaping project analyzer. A customer had a conversation about their landscaping needs. 

Please analyze this conversation and extract key project information in JSON format:

Customer conversation: "${transcription}"

Respond with a JSON object containing:
{
  "projectSummary": "Brief 1-2 sentence summary of what they want",
  "services": ["list", "of", "specific", "landscaping", "services"],
  "materials": ["list", "of", "materials", "mentioned", "or", "likely", "needed"],
  "problemAreas": ["specific", "issues", "they", "mentioned"],
  "projectScope": "small/medium/large based on description",
  "estimatedDuration": "rough timeline estimate",
  "notes": ["any", "special", "requests", "or", "important", "details"]
}

Focus on landscaping-specific terminology and be practical about what's achievable.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are a professional landscaping project analyzer. Always respond with valid JSON." },
        { role: "user", content: prompt }
      ],
      max_tokens: 800,
      temperature: 0.3
    });

    const analysisText = response.choices[0].message.content;
    console.log('GPT-4 Analysis:', analysisText);
    
    const analysis = JSON.parse(analysisText);
    return analysis;
    
  } catch (error) {
    console.error('Analysis error:', error);
    return {
      projectSummary: "Error analyzing project - please review transcription manually",
      services: ["Manual review needed"],
      materials: [],
      problemAreas: [],
      projectScope: "unknown",
      estimatedDuration: "TBD",
      notes: ["AI analysis failed - transcription: " + transcription]
    };
  }
}

async function generateEstimate(analysis, measurements = {}) {
  try {
    const estimatePrompt = `Based on this landscaping project analysis, provide quantity estimates and map services to pricing categories.

Project Analysis: ${JSON.stringify(analysis)}
Optional measurements: ${JSON.stringify(measurements)}

Available service categories: ${Object.keys(PRICING_DATABASE).join(', ')}
Available materials: ${Object.keys(MATERIAL_COSTS).join(', ')}

Respond with a JSON object:
{
  "serviceItems": [
    {
      "service": "service_key_from_database",
      "description": "What this service includes",
      "quantity": 100,
      "unit": "sq ft",
      "estimatedHours": 4,
      "notes": "Any special considerations"
    }
  ],
  "materialItems": [
    {
      "material": "material_key_from_database", 
      "description": "Material description",
      "quantity": 100,
      "unit": "sq ft"
    }
  ],
  "projectComplexity": "low/medium/high",
  "recommendedMeasurements": ["what should be measured on-site"],
  "assumptions": ["key assumptions made for this estimate"]
}

Be conservative with quantities if measurements aren't provided. Focus on the most likely services needed.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are a landscaping estimator. Always respond with valid JSON." },
        { role: "user", content: estimatePrompt }
      ],
      max_tokens: 1000,
      temperature: 0.2
    });

    const estimateData = JSON.parse(response.choices[0].message.content);
    
    let totalServiceCost = 0;
    let totalMaterialCost = 0;
    let totalLaborHours = 0;

    const serviceLineItems = estimateData.serviceItems.map(item => {
      const priceData = PRICING_DATABASE[item.service];
      if (!priceData) {
        console.warn(`Service not found in pricing database: ${item.service}`);
        return null;
      }

      const subtotal = item.quantity * priceData.rate;
      totalServiceCost += subtotal;
      totalLaborHours += item.estimatedHours || 0;

      return {
        description: item.description || priceData.description,
        quantity: item.quantity,
        unit: item.unit || priceData.unit,
        rate: priceData.rate,
        subtotal: subtotal,
        hours: item.estimatedHours || 0,
        notes: item.notes || ''
      };
    }).filter(Boolean);

    const materialLineItems = estimateData.materialItems.map(item => {
      const materialData = MATERIAL_COSTS[item.material];
      if (!materialData) {
        console.warn(`Material not found in database: ${item.material}`);
        return null;
      }

      const subtotal = item.quantity * materialData.cost;
      totalMaterialCost += subtotal;

      return {
        description: item.description || `${item.material} (${materialData.unit})`,
        quantity: item.quantity,
        unit: item.unit || materialData.unit,
        cost: materialData.cost,
        subtotal: subtotal
      };
    }).filter(Boolean);

    const materialMarkup = 1.25;
    const markedUpMaterials = totalMaterialCost * materialMarkup;
    const subtotal = totalServiceCost + markedUpMaterials;
    const taxRate = 0.08;
    const tax = subtotal * taxRate;
    const total = subtotal + tax;

    return {
      projectInfo: {
        summary: analysis.projectSummary,
        scope: analysis.projectScope,
        estimatedDuration: analysis.estimatedDuration
      },
      serviceItems: serviceLineItems,
      materialItems: materialLineItems,
      pricing: {
        laborSubtotal: totalServiceCost,
        materialSubtotal: totalMaterialCost,
        materialMarkup: markedUpMaterials - totalMaterialCost,
        subtotal: subtotal,
        tax: tax,
        total: total,
        totalHours: totalLaborHours
      },
      metadata: {
        complexity: estimateData.projectComplexity,
        assumptions: estimateData.assumptions,
        recommendedMeasurements: estimateData.recommendedMeasurements,
        createdDate: new Date().toLocaleDateString()
      }
    };

  } catch (error) {
    console.error('Estimate generation error:', error);
    return {
      error: 'Failed to generate estimate',
      message: error.message
    };
  }
}

// Original transcribe route
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    console.log('Received audio file:', req.file);
    console.log('File size:', req.file.size, 'bytes');
    
    const filePath = req.file.path;
    let newFilePath = filePath;
    
    // Fixed code
    if (req.file.originalname.includes('webm')) {
      newFilePath = filePath + '.webm';
    } else if (req.file.originalname.includes('mp4')) {
      newFilePath = filePath + '.mp4';
    } else if (req.file.originalname.includes('m4a')) {
      newFilePath = filePath + '.m4a';  // Handle m4a files correctly
    } else {
      // Keep original extension from filename
      const ext = req.file.originalname.split('.').pop();
      newFilePath = filePath + '.' + ext;
    }
    
    fs.renameSync(filePath, newFilePath);
    console.log('Processing audio file:', newFilePath);
    
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(newFilePath),
      model: 'whisper-1'
    });
    
    console.log('Transcription:', transcription.text);
    
    console.log('Starting GPT-4 analysis...');
    const analysis = await analyzeConversation(transcription.text);
    
    console.log('Analysis complete:', analysis);
    
    console.log('Generating estimate...');
    const estimate = await generateEstimate(analysis);
    
    console.log('Estimate generated:', estimate);
    
    fs.unlinkSync(newFilePath);
    
    res.json({ 
      text: transcription.text,
      analysis: analysis,
      estimate: estimate
    });
    
  } catch (error) {
    console.error('Detailed error:', error);
    
    if (req.file && req.file.path) {
      try {
        [req.file.path, req.file.path + '.webm', req.file.path + '.mp4'].forEach(path => {
          if (fs.existsSync(path)) fs.unlinkSync(path);
        });
      } catch (cleanupError) {
        console.log('Cleanup error:', cleanupError.message);
      }
    }
    
    res.status(500).json({ error: 'Processing failed: ' + error.message });
  }
});

// Webhook endpoints
app.post('/webhook/analyze-text', authenticateWebhook, async (req, res) => {
  try {
    const { text, customer_info } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    console.log('Webhook received text:', text);
    
    const analysis = await analyzeConversation(text);
    const estimate = await generateEstimate(analysis);
    
    res.json({
      success: true,
      customer_info: customer_info || {},
      transcription: text,
      analysis: analysis,
      estimate: estimate,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Processing failed: ' + error.message 
    });
  }
});

app.post('/webhook/analyze-audio', upload.single('audio'), async (req, res) => {
  try {
    const { customer_info } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'Audio file is required' });
    }

    console.log('Webhook received audio file:', req.file);
    
    const filePath = req.file.path;
    let newFilePath = filePath;
    
    if (req.file.originalname.includes('webm')) {
      newFilePath = filePath + '.webm';
    } else if (req.file.originalname.includes('mp4')) {
      newFilePath = filePath + '.mp4';
    } else {
      newFilePath = filePath + '.webm';
    }
    
    fs.renameSync(filePath, newFilePath);
    
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(newFilePath),
      model: 'whisper-1'
    });
    
    const analysis = await analyzeConversation(transcription.text);
    const estimate = await generateEstimate(analysis);
    
    fs.unlinkSync(newFilePath);
    
    res.json({
      success: true,
      customer_info: JSON.parse(customer_info || '{}'),
      transcription: transcription.text,
      analysis: analysis,
      estimate: estimate,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Audio webhook error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Processing failed: ' + error.message 
    });
  }
});

app.get('/webhook/status', (req, res) => {
  res.json({ 
    status: 'online', 
    timestamp: new Date().toISOString(),
    version: '1.3'
  });
});

app.post('/webhook/estimate-only', authenticateWebhook, async (req, res) => {
  try {
    const { analysis, customer_info } = req.body;
    
    if (!analysis) {
      return res.status(400).json({ error: 'Analysis object is required' });
    }

    const estimate = await generateEstimate(analysis);
    
    res.json({
      success: true,
      customer_info: customer_info || {},
      estimate: estimate,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Estimate webhook error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Estimate generation failed: ' + error.message 
    });
  }
});

// Debug route to check file system
app.get('/api/debug-files', (req, res) => {
  const files = fs.readdirSync('.');
  const jsFiles = files.filter(f => f.endsWith('.js'));
  
  res.json({ 
    allFiles: files,
    jsFiles: jsFiles,
    quickbooksExists: fs.existsSync('./quickbooks.js'),
    currentDir: __dirname,
    cwd: process.cwd(),
    timestamp: new Date().toISOString()
  });
});

app.use(express.static('.'));

db.initializeDatabase().then(() => {
  console.log('Database initialization complete');
}).catch(err => {
  console.error('Failed to initialize database:', err);
});

app.listen(port, () => {
  console.log(`Server is ready! Running on port ${port}`);
  console.log('Current working directory:', process.cwd());
  console.log('QuickBooks file check:', fs.existsSync('./quickbooks.js') ? '✅ Found' : '❌ Not found');
});